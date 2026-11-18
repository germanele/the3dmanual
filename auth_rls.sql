-- =============================================================================
-- MIGRACIÓN DE SEGURIDAD — Supabase Auth + RLS restrictivo
-- -----------------------------------------------------------------------------
-- Convierte la BD de "demo abierta" a "solo usuarios autenticados y
-- autorizados". NO borra datos.
--
-- ANTES DE EJECUTAR:
--   1) Supabase → Authentication → Providers → Email → habilitado.
--   2) Supabase → Authentication → Users → Add user (email + password).
--   3) Reemplazá TU-EMAIL@ejemplo.com por ese mismo email abajo.
--   4) SQL Editor → New query → Run.
--
-- Para agregar otro usuario después:
--   INSERT INTO public.usuarios_autorizados(email) VALUES ('otro@email.com');
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Lista blanca de correos autorizados
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usuarios_autorizados (
    email      TEXT PRIMARY KEY,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⬇️ EDITAR: poné el email del usuario que creaste en Authentication
INSERT INTO public.usuarios_autorizados(email)
VALUES ('labragagerman@gmail.com')
ON CONFLICT (email) DO NOTHING;

ALTER TABLE public.usuarios_autorizados ENABLE ROW LEVEL SECURITY;

-- Cada usuario solo puede ver su propia fila de autorización.
DROP POLICY IF EXISTS i3d_ver_propia_autorizacion ON public.usuarios_autorizados;
CREATE POLICY i3d_ver_propia_autorizacion ON public.usuarios_autorizados
    FOR SELECT TO authenticated
    USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

REVOKE ALL ON public.usuarios_autorizados FROM anon;
GRANT SELECT ON public.usuarios_autorizados TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Función central de autorización (la usan las políticas y las RPCs)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.i3d_usuario_autorizado()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT auth.uid() IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM public.usuarios_autorizados ua
            WHERE lower(ua.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       );
$$;

REVOKE ALL ON FUNCTION public.i3d_usuario_autorizado() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.i3d_usuario_autorizado() TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Reemplazar la política abierta por una restrictiva en todas las tablas.
--    Se omiten las tablas que aún no existen: este archivo puede correrse antes
--    o después de mejoras.sql (las tablas nuevas se protegen allí también).
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'parametros_base','articulos','mediciones_slicer','registro_costos',
        'combos','combo_items','pedidos','pedido_items',
        'clientes','filamentos','movimientos_filamento'
    ] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('DROP POLICY IF EXISTS "i3d_acceso_publico" ON %I', t);
            EXECUTE format('DROP POLICY IF EXISTS "i3d_acceso_autenticado" ON %I', t);
            EXECUTE format(
                'CREATE POLICY "i3d_acceso_autenticado" ON %I FOR ALL TO authenticated '
                'USING (public.i3d_usuario_autorizado()) '
                'WITH CHECK (public.i3d_usuario_autorizado())',
                t
            );
        END IF;
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Quitar permisos al rol anon en tablas, vistas y RPCs
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'parametros_base','articulos','mediciones_slicer','registro_costos',
        'combos','combo_items','pedidos','pedido_items',
        'clientes','filamentos','movimientos_filamento'
    ] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
        END IF;
    END LOOP;
END $$;

REVOKE ALL ON v_catalogo_articulos, v_combos_detalle, v_resumen_pedidos FROM anon;
GRANT SELECT ON v_catalogo_articulos, v_combos_detalle, v_resumen_pedidos TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Recrear las RPCs con guarda de autorización
--    (son SECURITY DEFINER, por eso no basta con RLS: hay que validar dentro)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION api_obtener_o_crear_articulo(p_nombre TEXT)
RETURNS SETOF articulos
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_limpio TEXT;
    v_id     BIGINT;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;

    v_limpio := regexp_replace(coalesce(p_nombre, ''), '^ART-\d+\s*\|\s*', '', 'ig');
    v_limpio := btrim(v_limpio);

    IF v_limpio = '' THEN
        RAISE EXCEPTION 'El nombre del artículo no puede estar vacío';
    END IF;

    INSERT INTO articulos(nombre)
    VALUES (v_limpio)
    ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
    RETURNING id INTO v_id;

    RETURN QUERY SELECT a.* FROM articulos a WHERE a.id = v_id;
END $$;

CREATE OR REPLACE FUNCTION api_guardar_combo(
    p_nombre        TEXT,
    p_fecha         DATE,
    p_presupuesto   NUMERIC,
    p_opcion        TEXT,
    p_composicion   TEXT,
    p_precio_venta  NUMERIC,
    p_costo         NUMERIC,
    p_saldo         NUMERIC,
    p_items         JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id  BIGINT;
    v_it  JSONB;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;

    IF btrim(coalesce(p_nombre, '')) = '' THEN
        RAISE EXCEPTION 'Debe indicar el nombre del combo';
    END IF;
    IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
        RAISE EXCEPTION 'El combo debe tener al menos un artículo';
    END IF;

    INSERT INTO combos(fecha, nombre, presupuesto, opcion, composicion,
                       precio_venta, costo_produccion, saldo)
    VALUES (p_fecha, btrim(p_nombre), p_presupuesto, p_opcion, p_composicion,
            p_precio_venta, p_costo, p_saldo)
    RETURNING id INTO v_id;

    FOR v_it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        INSERT INTO combo_items(combo_id, articulo_id, cantidad, descripcion, precio_unitario)
        VALUES (
            v_id,
            (v_it->>'articuloId')::BIGINT,
            GREATEST(1, COALESCE((v_it->>'cantidad')::INTEGER, 1)),
            COALESCE(v_it->>'descripcion', ''),
            GREATEST(0, COALESCE((v_it->>'precioUnitario')::NUMERIC, 0))
        );
    END LOOP;

    RETURN v_id;
END $$;

-- Se retiran las firmas viejas para que no queden RPCs sin datos fiscales.
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB) CASCADE;
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN, BIGINT, TEXT, TEXT, TEXT, DATE) CASCADE;

CREATE OR REPLACE FUNCTION api_crear_pedido(
    p_cliente         TEXT,
    p_fecha           DATE,
    p_estado          TEXT,
    p_items           JSONB,
    p_con_factura     BOOLEAN DEFAULT false,
    p_cliente_id      BIGINT DEFAULT NULL,
    p_rut             TEXT DEFAULT NULL,
    p_razon_social    TEXT DEFAULT NULL,
    p_numero_factura  TEXT DEFAULT NULL,
    p_fecha_factura   DATE DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id      BIGINT;
    v_codigo  TEXT;
    v_it      JSONB;
    v_estado  estado_pedido;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;

    v_estado := p_estado::estado_pedido;

    IF btrim(coalesce(p_cliente, '')) = '' THEN
        RAISE EXCEPTION 'Debe indicar el nombre del cliente';
    END IF;
    IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
        RAISE EXCEPTION 'El pedido debe tener al menos un ítem';
    END IF;
    IF coalesce(p_con_factura, false) AND btrim(coalesce(p_rut, '')) = '' THEN
        RAISE EXCEPTION 'Un pedido con factura debe tener RUT';
    END IF;

    INSERT INTO pedidos(cliente, cliente_id, fecha, estado, con_factura,
                        rut, razon_social, numero_factura, fecha_factura)
    VALUES (btrim(p_cliente), p_cliente_id, p_fecha, v_estado,
            coalesce(p_con_factura, false),
            nullif(btrim(coalesce(p_rut, '')), ''),
            nullif(btrim(coalesce(p_razon_social, '')), ''),
            nullif(btrim(coalesce(p_numero_factura, '')), ''),
            p_fecha_factura)
    RETURNING id, codigo INTO v_id, v_codigo;

    FOR v_it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        INSERT INTO pedido_items(pedido_id, tipo, articulo_id, combo_id,
                                 descripcion, cantidad, precio_unitario)
        VALUES (
            v_id,
            COALESCE(v_it->>'tipo', 'articulo')::tipo_item_pedido,
            NULLIF(v_it->>'articuloId', '')::BIGINT,
            NULLIF(v_it->>'comboId', '')::BIGINT,
            COALESCE(v_it->>'descripcion', ''),
            GREATEST(1, COALESCE((v_it->>'cantidad')::INTEGER, 1)),
            GREATEST(0, COALESCE((v_it->>'precioUnitario')::NUMERIC, 0))
        );
    END LOOP;

    RETURN v_codigo;
END $$;

-- Permisos sobre todas las RPC (solo si existen: este archivo puede correrse
-- antes o después de la migración de mejoras).
DO $$
DECLARE fn TEXT;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'api_obtener_o_crear_articulo','api_obtener_o_crear_cliente',
        'api_guardar_medicion','api_crear_filamento','api_mover_filamento',
        'api_guardar_combo','api_crear_pedido'
    ] LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = fn
        ) THEN
            EXECUTE format('REVOKE ALL ON FUNCTION public.%I FROM anon', fn);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I TO authenticated', fn);
        END IF;
    END LOOP;
END $$;

COMMIT;

-- =============================================================================
-- Verificación rápida (opcional)
-- -----------------------------------------------------------------------------
-- SELECT public.i3d_usuario_autorizado() AS autorizado;  -- debe dar true al loguearte
-- SELECT email FROM public.usuarios_autorizados;
-- SELECT policyname, roles FROM pg_policies WHERE tablename = 'pedidos';
-- =============================================================================
