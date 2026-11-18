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
-- 3. Reemplazar la política abierta por una restrictiva en las 8 tablas
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'parametros_base','articulos','mediciones_slicer','registro_costos',
        'combos','combo_items','pedidos','pedido_items'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "i3d_acceso_publico" ON %I', t);
        EXECUTE format('DROP POLICY IF EXISTS "i3d_acceso_autenticado" ON %I', t);
        EXECUTE format(
            'CREATE POLICY "i3d_acceso_autenticado" ON %I FOR ALL TO authenticated '
            'USING (public.i3d_usuario_autorizado()) '
            'WITH CHECK (public.i3d_usuario_autorizado())',
            t
        );
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Quitar permisos al rol anon en tablas, vistas y RPCs
-- -----------------------------------------------------------------------------
REVOKE ALL ON TABLE
    parametros_base, articulos, mediciones_slicer, registro_costos,
    combos, combo_items, pedidos, pedido_items
FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    parametros_base, articulos, mediciones_slicer, registro_costos,
    combos, combo_items, pedidos, pedido_items
TO authenticated;

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

CREATE OR REPLACE FUNCTION api_crear_pedido(
    p_cliente      TEXT,
    p_fecha        DATE,
    p_estado       TEXT,
    p_items        JSONB,
    p_con_factura  BOOLEAN DEFAULT false
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

    INSERT INTO pedidos(cliente, fecha, estado, con_factura)
    VALUES (btrim(p_cliente), p_fecha, v_estado, coalesce(p_con_factura, false))
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

REVOKE ALL ON FUNCTION api_obtener_o_crear_articulo(TEXT) FROM anon;
REVOKE ALL ON FUNCTION api_guardar_combo(TEXT, DATE, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB) FROM anon;
REVOKE ALL ON FUNCTION api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN) FROM anon;

GRANT EXECUTE ON FUNCTION api_obtener_o_crear_articulo(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION api_guardar_combo(TEXT, DATE, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN) TO authenticated;

COMMIT;

-- =============================================================================
-- Verificación rápida (opcional)
-- -----------------------------------------------------------------------------
-- SELECT public.i3d_usuario_autorizado() AS autorizado;  -- debe dar true al loguearte
-- SELECT email FROM public.usuarios_autorizados;
-- SELECT policyname, roles FROM pg_policies WHERE tablename = 'pedidos';
-- =============================================================================
