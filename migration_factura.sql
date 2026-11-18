-- =============================================================================
-- MIGRACIÓN — Facturación con IVA 22 % + fix de RPC de artículos
-- -----------------------------------------------------------------------------
-- Para una BD que YA tiene aplicado supabase_schema.sql.
-- NO borra datos: solo agrega la columna, actualiza la vista y las RPCs.
--
-- Ejecutar en: Supabase → SQL Editor → New query → Run.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Nueva columna de facturación en pedidos
-- -----------------------------------------------------------------------------
ALTER TABLE pedidos
    ADD COLUMN IF NOT EXISTS con_factura BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN pedidos.con_factura IS
    'Si es true, el total del pedido incluye 22 % de IVA sobre el subtotal.';

-- -----------------------------------------------------------------------------
-- 2. Fix preventivo de api_obtener_o_crear_articulo (error 42702)
--    Si ya aplicaste fix_rpc.sql, esto es inocuo.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS api_obtener_o_crear_articulo(TEXT) CASCADE;

CREATE OR REPLACE FUNCTION api_obtener_o_crear_articulo(p_nombre TEXT)
RETURNS SETOF articulos
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_limpio TEXT;
    v_id     BIGINT;
BEGIN
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

-- -----------------------------------------------------------------------------
-- 3. Recrear api_crear_pedido con el parámetro p_con_factura
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB) CASCADE;
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN) CASCADE;

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

-- -----------------------------------------------------------------------------
-- 4. Recrear la vista de resumen con subtotal, IVA y total
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_resumen_pedidos CASCADE;

CREATE VIEW v_resumen_pedidos AS
SELECT p.id, p.codigo, p.fecha, p.cliente, p.estado, p.con_factura,
       COUNT(pi.id) AS cant_items,
       COALESCE(SUM(pi.cantidad), 0) AS total_piezas,
       ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0), 2) AS subtotal_uyu,
       ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0) *
             CASE WHEN p.con_factura THEN 0.22 ELSE 0 END, 2) AS iva_uyu,
       ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0) *
             CASE WHEN p.con_factura THEN 1.22 ELSE 1 END, 2) AS total_uyu
FROM pedidos p
LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.codigo, p.fecha, p.cliente, p.estado, p.con_factura;

-- -----------------------------------------------------------------------------
-- 5. Restaurar permisos (los DROP ... CASCADE los eliminaron)
-- -----------------------------------------------------------------------------
GRANT SELECT ON v_resumen_pedidos TO anon, authenticated;
GRANT EXECUTE ON FUNCTION api_obtener_o_crear_articulo(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN) TO anon, authenticated;

COMMIT;

-- =============================================================================
-- Verificación rápida (opcional)
-- -----------------------------------------------------------------------------
-- SELECT codigo, cliente, con_factura, subtotal_uyu, iva_uyu, total_uyu
-- FROM v_resumen_pedidos ORDER BY id LIMIT 5;
-- =============================================================================
