-- =============================================================================
-- MIGRACIÓN DE MEJORAS — Clientes, datos fiscales e inventario de filamento
-- -----------------------------------------------------------------------------
-- Se ejecuta sobre una BD v2 que YA tiene datos. NO borra nada.
-- Requiere que ya estén aplicados: supabase_schema.sql + migration_factura.sql
-- + auth_rls.sql (esta última crea i3d_usuario_autorizado(), que usan las RPCs
-- nuevas). Orden recomendado: migration_factura.sql → auth_rls.sql → mejoras.sql.
--
-- SQL Editor → New query → pegar todo → Run.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. TIPO para los movimientos de inventario
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    CREATE TYPE movimiento_filamento AS ENUM ('entrada', 'consumo', 'ajuste');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. TABLAS NUEVAS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clientes (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre       TEXT NOT NULL UNIQUE,
    rut          TEXT,
    razon_social TEXT,
    telefono     TEXT,
    email        TEXT,
    direccion    TEXT,
    notas        TEXT,
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_cliente_rut_vacio CHECK (rut IS NULL OR btrim(rut) <> '')
);

CREATE TABLE IF NOT EXISTS public.filamentos (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo         TEXT GENERATED ALWAYS AS ('FIL-' || lpad(id::TEXT, 3, '0')) STORED NOT NULL UNIQUE,
    nombre         TEXT NOT NULL,
    material       TEXT NOT NULL,
    color          TEXT NOT NULL,
    kg_disponibles NUMERIC(10, 3) NOT NULL DEFAULT 0 CHECK (kg_disponibles >= 0),
    kg_alerta      NUMERIC(10, 3) NOT NULL DEFAULT 0.5 CHECK (kg_alerta >= 0),
    costo_kg       NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (costo_kg >= 0),
    proveedor      TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_filamento_material_color UNIQUE (material, color)
);

CREATE TABLE IF NOT EXISTS public.movimientos_filamento (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filamento_id  BIGINT NOT NULL REFERENCES filamentos(id) ON DELETE RESTRICT,
    fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
    tipo          movimiento_filamento NOT NULL,
    kg            NUMERIC(10, 3) NOT NULL CHECK (kg <> 0),
    motivo        TEXT,
    medicion_id   BIGINT REFERENCES mediciones_slicer(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 3. COLUMNAS NUEVAS EN PEDIDOS + BACKFILL DE CLIENTES
-- -----------------------------------------------------------------------------
ALTER TABLE public.pedidos
    ADD COLUMN IF NOT EXISTS cliente_id     BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS rut            TEXT,
    ADD COLUMN IF NOT EXISTS razon_social   TEXT,
    ADD COLUMN IF NOT EXISTS numero_factura TEXT,
    ADD COLUMN IF NOT EXISTS fecha_factura  DATE;

DO $$
BEGIN
    ALTER TABLE public.pedidos ADD CONSTRAINT uq_numero_factura UNIQUE (numero_factura);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Convierte cada nombre de cliente existente en una fila de la tabla nueva.
INSERT INTO public.clientes(nombre)
SELECT DISTINCT btrim(cliente)
FROM public.pedidos
WHERE btrim(coalesce(cliente, '')) <> ''
ON CONFLICT (nombre) DO NOTHING;

UPDATE public.pedidos p
SET cliente_id = c.id
FROM public.clientes c
WHERE p.cliente_id IS NULL
  AND lower(btrim(c.nombre)) = lower(btrim(p.cliente));

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON public.pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_factura ON public.pedidos(numero_factura);
CREATE INDEX IF NOT EXISTS idx_mov_filamento_fil ON public.movimientos_filamento(filamento_id, fecha DESC);

-- -----------------------------------------------------------------------------
-- 4. VISTA ACTUALIZADA (incluye los datos fiscales)
--    CREATE OR REPLACE VIEW no permite cambiar el orden/nombre de columnas de
--    una vista ya existente (error 42P16), así que se recrea. No hay pérdida
--    de datos: es solo una definición.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_resumen_pedidos CASCADE;

CREATE OR REPLACE VIEW v_resumen_pedidos AS
SELECT p.id, p.codigo, p.fecha, p.cliente, p.cliente_id, p.estado, p.con_factura,
       p.rut, p.razon_social, p.numero_factura, p.fecha_factura,
       COUNT(pi.id) AS cant_items,
       COALESCE(SUM(pi.cantidad), 0) AS total_piezas,
       ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0), 2) AS subtotal_uyu,
       ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0) *
             CASE WHEN p.con_factura THEN 0.22 ELSE 0 END, 2) AS iva_uyu,
       ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0) *
             CASE WHEN p.con_factura THEN 1.22 ELSE 1 END, 2) AS total_uyu
FROM pedidos p
LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.codigo, p.fecha, p.cliente, p.cliente_id, p.estado, p.con_factura,
         p.rut, p.razon_social, p.numero_factura, p.fecha_factura;

-- -----------------------------------------------------------------------------
-- 5. RPCs NUEVAS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_obtener_o_crear_cliente(
    p_nombre        TEXT,
    p_rut           TEXT DEFAULT NULL,
    p_razon_social  TEXT DEFAULT NULL,
    p_telefono      TEXT DEFAULT NULL,
    p_email         TEXT DEFAULT NULL
)
RETURNS SETOF clientes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT; v_limpio TEXT;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN RAISE EXCEPTION 'No autorizado'; END IF;
    v_limpio := btrim(coalesce(p_nombre, ''));
    IF v_limpio = '' THEN RAISE EXCEPTION 'El nombre del cliente no puede estar vacío'; END IF;

    INSERT INTO clientes(nombre, rut, razon_social, telefono, email)
    VALUES (v_limpio,
            nullif(btrim(coalesce(p_rut, '')), ''),
            nullif(btrim(coalesce(p_razon_social, '')), ''),
            nullif(btrim(coalesce(p_telefono, '')), ''),
            nullif(btrim(coalesce(p_email, '')), ''))
    ON CONFLICT (nombre) DO UPDATE SET
        rut          = COALESCE(clientes.rut, EXCLUDED.rut),
        razon_social = COALESCE(clientes.razon_social, EXCLUDED.razon_social),
        telefono     = COALESCE(clientes.telefono, EXCLUDED.telefono),
        email        = COALESCE(clientes.email, EXCLUDED.email)
    RETURNING id INTO v_id;

    RETURN QUERY SELECT c.* FROM clientes c WHERE c.id = v_id;
END $$;

CREATE OR REPLACE FUNCTION api_guardar_medicion(
    p_fecha         DATE,
    p_articulo_id   BIGINT,
    p_cantidad      INTEGER,
    p_gramos        NUMERIC,
    p_impresion     NUMERIC,
    p_preparacion   NUMERIC,
    p_post          NUMERIC,
    p_factor        NUMERIC,
    p_filamento_id  BIGINT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT; v_existe BOOLEAN; v_kg NUMERIC(10,3); v_consumo NUMERIC(10,3);
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN RAISE EXCEPTION 'No autorizado'; END IF;
    IF coalesce(p_cantidad, 0) < 1 THEN RAISE EXCEPTION 'La cantidad debe ser al menos 1'; END IF;
    IF coalesce(p_gramos, 0) < 0 THEN RAISE EXCEPTION 'Los gramos no pueden ser negativos'; END IF;

    SELECT EXISTS (SELECT 1 FROM mediciones_slicer
                   WHERE articulo_id = p_articulo_id AND cantidad = p_cantidad) INTO v_existe;

    INSERT INTO mediciones_slicer(fecha, articulo_id, cantidad, gramos_lote,
        horas_impresion_lote, horas_preparacion_lote, horas_postprocesado_unit, factor)
    VALUES (p_fecha, p_articulo_id, p_cantidad, p_gramos, p_impresion,
            p_preparacion, p_post, p_factor)
    ON CONFLICT (articulo_id, cantidad) DO UPDATE SET
        fecha                    = EXCLUDED.fecha,
        gramos_lote              = EXCLUDED.gramos_lote,
        horas_impresion_lote     = EXCLUDED.horas_impresion_lote,
        horas_preparacion_lote   = EXCLUDED.horas_preparacion_lote,
        horas_postprocesado_unit = EXCLUDED.horas_postprocesado_unit,
        factor                   = EXCLUDED.factor
    RETURNING id INTO v_id;

    IF (NOT v_existe) AND p_filamento_id IS NOT NULL AND coalesce(p_gramos, 0) > 0 THEN
        v_consumo := ROUND(p_gramos / 1000, 3);
        SELECT kg_disponibles INTO v_kg FROM filamentos WHERE id = p_filamento_id;
        IF v_kg IS NULL THEN RAISE EXCEPTION 'No existe el filamento indicado'; END IF;
        IF v_kg < v_consumo THEN
            RAISE EXCEPTION 'Stock insuficiente: hay % kg y la medición consume % kg', v_kg, v_consumo;
        END IF;
        INSERT INTO movimientos_filamento(filamento_id, fecha, tipo, kg, motivo, medicion_id)
        VALUES (p_filamento_id, p_fecha, 'consumo', -v_consumo,
                'Consumo por medición del slicer', v_id);
        UPDATE filamentos
        SET kg_disponibles = ROUND(kg_disponibles - v_consumo, 3)
        WHERE id = p_filamento_id;
    END IF;

    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION api_crear_filamento(
    p_nombre      TEXT,
    p_material    TEXT,
    p_color       TEXT,
    p_kg_inicial  NUMERIC DEFAULT 0,
    p_kg_alerta   NUMERIC DEFAULT 0.5,
    p_costo_kg    NUMERIC DEFAULT 0,
    p_proveedor   TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN RAISE EXCEPTION 'No autorizado'; END IF;
    IF btrim(coalesce(p_nombre,'')) = '' OR btrim(coalesce(p_material,'')) = ''
       OR btrim(coalesce(p_color,'')) = '' THEN
        RAISE EXCEPTION 'Nombre, material y color son obligatorios';
    END IF;
    IF coalesce(p_kg_inicial, 0) < 0 THEN RAISE EXCEPTION 'El stock inicial no puede ser negativo'; END IF;

    INSERT INTO filamentos(nombre, material, color, kg_disponibles, kg_alerta, costo_kg, proveedor)
    VALUES (btrim(p_nombre), btrim(p_material), btrim(p_color),
            ROUND(coalesce(p_kg_inicial, 0), 3), ROUND(coalesce(p_kg_alerta, 0.5), 3),
            coalesce(p_costo_kg, 0), nullif(btrim(coalesce(p_proveedor, '')), ''))
    RETURNING id INTO v_id;

    IF coalesce(p_kg_inicial, 0) > 0 THEN
        INSERT INTO movimientos_filamento(filamento_id, fecha, tipo, kg, motivo)
        VALUES (v_id, CURRENT_DATE, 'entrada', ROUND(p_kg_inicial, 3), 'Stock inicial');
    END IF;
    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION api_mover_filamento(
    p_filamento_id  BIGINT,
    p_tipo          TEXT,
    p_kg            NUMERIC,
    p_motivo        TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_kg NUMERIC(10,3); v_delta NUMERIC(10,3);
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN RAISE EXCEPTION 'No autorizado'; END IF;
    IF coalesce(p_kg, 0) = 0 THEN RAISE EXCEPTION 'Ingresá una cantidad de kg distinta de cero'; END IF;
    IF p_tipo NOT IN ('entrada', 'ajuste') THEN RAISE EXCEPTION 'Tipo de movimiento inválido'; END IF;

    SELECT kg_disponibles INTO v_kg FROM filamentos WHERE id = p_filamento_id FOR UPDATE;
    IF v_kg IS NULL THEN RAISE EXCEPTION 'No existe el filamento indicado'; END IF;
    IF p_tipo = 'entrada' AND p_kg <= 0 THEN RAISE EXCEPTION 'Una entrada debe ser positiva'; END IF;

    v_delta := ROUND(p_kg, 3);
    IF v_kg + v_delta < 0 THEN RAISE EXCEPTION 'El movimiento dejaría stock negativo'; END IF;

    UPDATE filamentos SET kg_disponibles = ROUND(kg_disponibles + v_delta, 3)
    WHERE id = p_filamento_id;
    INSERT INTO movimientos_filamento(filamento_id, fecha, tipo, kg, motivo)
    VALUES (p_filamento_id, CURRENT_DATE, p_tipo::movimiento_filamento, v_delta, p_motivo);
END $$;

-- -----------------------------------------------------------------------------
-- 6. RPC DE PEDIDO CON DATOS FISCALES (se reemplaza la firma vieja)
-- -----------------------------------------------------------------------------
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
DECLARE v_id BIGINT; v_codigo TEXT; v_it JSONB; v_estado estado_pedido;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN RAISE EXCEPTION 'No autorizado'; END IF;
    v_estado := p_estado::estado_pedido;

    IF btrim(coalesce(p_cliente, '')) = '' THEN RAISE EXCEPTION 'Debe indicar el nombre del cliente'; END IF;
    IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'El pedido debe tener al menos un ítem'; END IF;
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

-- -----------------------------------------------------------------------------
-- 7. SEGURIDAD de las tablas y RPCs nuevas
-- -----------------------------------------------------------------------------
ALTER TABLE public.clientes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filamentos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_filamento ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['clientes','filamentos','movimientos_filamento'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "i3d_acceso_publico" ON %I', t);
        EXECUTE format('DROP POLICY IF EXISTS "i3d_acceso_autenticado" ON %I', t);
        EXECUTE format(
            'CREATE POLICY "i3d_acceso_autenticado" ON %I FOR ALL TO authenticated '
            'USING (public.i3d_usuario_autorizado()) '
            'WITH CHECK (public.i3d_usuario_autorizado())', t);
    END LOOP;
END $$;

REVOKE ALL ON TABLE public.clientes, public.filamentos, public.movimientos_filamento FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.clientes, public.filamentos, public.movimientos_filamento TO authenticated;

DO $$
DECLARE fn TEXT;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'api_obtener_o_crear_cliente','api_guardar_medicion',
        'api_crear_filamento','api_mover_filamento','api_crear_pedido'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%I FROM anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I TO authenticated', fn);
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 8. STOCK INICIAL DE EJEMPLO (solo si no hay filamentos cargados)
-- -----------------------------------------------------------------------------
INSERT INTO public.filamentos (nombre, material, color, kg_disponibles, kg_alerta, costo_kg, proveedor)
SELECT v.nombre, v.material, v.color, v.kg, 0.500, v.costo, v.proveedor
FROM (VALUES
    ('PLA Negro',  'PLA',  'Negro',  2.400::NUMERIC, 18.00::NUMERIC, 'Local 3D'),
    ('PLA Blanco', 'PLA',  'Blanco', 1.100::NUMERIC, 18.00::NUMERIC, 'Local 3D'),
    ('PETG Azul',  'PETG', 'Azul',   0.350::NUMERIC, 22.50::NUMERIC, 'Impresora UY')
) AS v(nombre, material, color, kg, costo, proveedor)
WHERE NOT EXISTS (SELECT 1 FROM public.filamentos f
                  WHERE f.material = v.material AND f.color = v.color);

INSERT INTO public.movimientos_filamento (filamento_id, fecha, tipo, kg, motivo)
SELECT f.id, CURRENT_DATE, 'entrada', f.kg_disponibles, 'Stock inicial'
FROM public.filamentos f
WHERE NOT EXISTS (SELECT 1 FROM public.movimientos_filamento m WHERE m.filamento_id = f.id);

COMMIT;

-- =============================================================================
-- Verificación rápida (opcional)
-- SELECT count(*) AS clientes FROM public.clientes;
-- SELECT id, codigo, nombre, kg_disponibles FROM public.filamentos;
-- SELECT p.codigo, p.cliente, c.nombre AS cliente_vinculado
--   FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id;
-- =============================================================================
