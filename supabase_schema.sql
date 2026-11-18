-- =============================================================================
-- GESTIÓN DE IMPRESIÓN 3D (URUGUAY) — SCHEMA v2
-- Base de datos reconstruida desde cero para Supabase / PostgreSQL
-- =============================================================================
-- ⚠️  ADVERTENCIA: este script ELIMINA las tablas de la versión anterior y sus
--     datos, y crea un modelo normalizado nuevo con datos de ejemplo.
--     Ejecutarlo una sola vez en: Supabase → SQL Editor → New query → Run.
-- =============================================================================
-- Cambios frente al esquema anterior:
--   · DINERO usa NUMERIC(14,2) en vez de REAL (errores de coma flotante).
--   · FECHAS usan DATE en vez de TEXT (ordenación y validación reales).
--   · IDs ART-XXX / PED-XXX los genera PostgreSQL (identity + columna
--     generada), no JavaScript → sin carreras ni contadores desincronizados.
--   · pedido_items usa FKs reales (articulo_id / combo_id) con un CHECK
--     de origen exclusivo, en vez de un ref_id TEXT polimórfico.
--   · Los combos guardados son snapshots estructurados (combos + combo_items).
--   · UNIQUE (articulo_id, cantidad) permite upsert atómico de mediciones.
--   · Estados y tipos son ENUM → valores controlados por la BD.
--   · audit columns creado_en / actualizado_en + trigger de auditoría.
--   · Operaciones críticas (pedido y combo completos) son RPC transaccionales.
--   · RLS explícito por tabla y grants mínimos para anon/authenticated.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. LIMPIEZA (reconstrucción total)
-- -----------------------------------------------------------------------------
DROP VIEW  IF EXISTS v_catalogo_articulos CASCADE;
DROP VIEW  IF EXISTS v_pedidos CASCADE;
DROP VIEW  IF EXISTS v_resumen_pedidos CASCADE;
DROP VIEW  IF EXISTS v_combos_detalle CASCADE;

DROP FUNCTION IF EXISTS api_obtener_o_crear_articulo(TEXT) CASCADE;
DROP FUNCTION IF EXISTS api_guardar_combo(TEXT, DATE, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB) CASCADE;
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB) CASCADE;
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS api_crear_pedido(TEXT, DATE, TEXT, JSONB, BOOLEAN, BIGINT, TEXT, TEXT, TEXT, DATE) CASCADE;
DROP FUNCTION IF EXISTS api_guardar_medicion CASCADE;
DROP FUNCTION IF EXISTS api_crear_filamento CASCADE;
DROP FUNCTION IF EXISTS api_mover_filamento CASCADE;
DROP FUNCTION IF EXISTS api_obtener_o_crear_cliente CASCADE;
DROP FUNCTION IF EXISTS touch_actualizado_en() CASCADE;

DROP TABLE IF EXISTS movimientos_filamento CASCADE;
DROP TABLE IF EXISTS filamentos            CASCADE;
DROP TABLE IF EXISTS pedido_items          CASCADE;
DROP TABLE IF EXISTS pedidos               CASCADE;
DROP TABLE IF EXISTS clientes              CASCADE;
DROP TABLE IF EXISTS combo_items       CASCADE;
DROP TABLE IF EXISTS combos            CASCADE;
DROP TABLE IF EXISTS registro_costos   CASCADE;
DROP TABLE IF EXISTS mediciones_slicer CASCADE;
DROP TABLE IF EXISTS articulos         CASCADE;
DROP TABLE IF EXISTS parametros_base   CASCADE;

DROP TABLE IF EXISTS registro_costos_old       CASCADE;
DROP TABLE IF EXISTS escalas_reales            CASCADE;
DROP TABLE IF EXISTS combos_guardados          CASCADE;
DROP VIEW  IF EXISTS v_catalogo_articulos      CASCADE;
DROP VIEW  IF EXISTS v_pedidos                 CASCADE;

DROP TYPE IF EXISTS movimiento_filamento CASCADE;
DROP TYPE IF EXISTS tipo_item_pedido     CASCADE;
DROP TYPE IF EXISTS estado_pedido        CASCADE;

-- -----------------------------------------------------------------------------
-- 1. TIPOS CONTROLADOS
-- -----------------------------------------------------------------------------
CREATE TYPE estado_pedido AS ENUM (
    'Pendiente',
    'En Producción',
    'Listo para Entrega',
    'Entregado',
    'Cancelado'
);

CREATE TYPE tipo_item_pedido AS ENUM ('articulo', 'combo');

-- -----------------------------------------------------------------------------
-- 2. PARÁMETROS OPERATIVOS (tabla de referencia)
-- -----------------------------------------------------------------------------
CREATE TABLE parametros_base (
    clave           TEXT PRIMARY KEY,
    etiqueta        TEXT NOT NULL,
    valor           NUMERIC(16, 4) NOT NULL CHECK (valor >= 0),
    unidad          TEXT NOT NULL,
    base            TEXT NOT NULL,
    notas           TEXT,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE parametros_base IS
    'Parámetros económicos de Uruguay que alimentan todas las fórmulas de costo.';

-- -----------------------------------------------------------------------------
-- 3. ARTÍCULOS  (código ART-XXX generado por la base de datos)
-- -----------------------------------------------------------------------------
CREATE TABLE articulos (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo      TEXT GENERATED ALWAYS AS ('ART-' || lpad(id::TEXT, 3, '0')) STORED NOT NULL UNIQUE,
    nombre      TEXT NOT NULL UNIQUE,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN articulos.codigo IS
    'Identificador público inmutable generado por PostgreSQL a partir del identity.';

-- -----------------------------------------------------------------------------
-- 4. MEDICIONES REALES DEL SLICER (antiguas "escalas_reales")
-- -----------------------------------------------------------------------------
CREATE TABLE mediciones_slicer (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha                       DATE NOT NULL,
    articulo_id                 BIGINT NOT NULL REFERENCES articulos(id) ON DELETE CASCADE,
    cantidad                    INTEGER NOT NULL CHECK (cantidad >= 1),
    gramos_lote                 NUMERIC(12, 3) NOT NULL CHECK (gramos_lote >= 0),
    horas_impresion_lote        NUMERIC(12, 6) NOT NULL CHECK (horas_impresion_lote >= 0),
    horas_preparacion_lote      NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (horas_preparacion_lote >= 0),
    horas_postprocesado_unit    NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (horas_postprocesado_unit >= 0),
    factor                      NUMERIC(6, 2) NOT NULL DEFAULT 2.50 CHECK (factor > 0),
    creado_en                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_medicion_articulo_cantidad UNIQUE (articulo_id, cantidad)
);

COMMENT ON TABLE mediciones_slicer IS
    'Mediciones reales por lote. Una fila por (artículo, cantidad) → upsert atómico.';

-- -----------------------------------------------------------------------------
-- 5. REGISTRO DE COSTOS (configuración de venta por artículo / lote)
-- -----------------------------------------------------------------------------
CREATE TABLE registro_costos (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    articulo_id     BIGINT NOT NULL REFERENCES articulos(id) ON DELETE CASCADE,
    cantidad        INTEGER NOT NULL CHECK (cantidad >= 1),
    factor          NUMERIC(6, 2) NOT NULL DEFAULT 2.50 CHECK (factor > 0),
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_registro_articulo_cantidad UNIQUE (articulo_id, cantidad)
);

-- -----------------------------------------------------------------------------
-- 6. COMBOS GUARDADOS (snapshot de una cotización + detalle estructurado)
-- -----------------------------------------------------------------------------
CREATE TABLE combos (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha               DATE NOT NULL,
    nombre              TEXT NOT NULL,
    presupuesto         NUMERIC(14, 2) NOT NULL CHECK (presupuesto >= 0),
    opcion              TEXT NOT NULL,
    composicion         TEXT NOT NULL,
    precio_venta        NUMERIC(14, 2) NOT NULL CHECK (precio_venta >= 0),
    costo_produccion    NUMERIC(14, 2) NOT NULL CHECK (costo_produccion >= 0),
    saldo               NUMERIC(14, 2) NOT NULL,
    estado              TEXT NOT NULL DEFAULT '✅ Guardado',
    creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_combo_nombre_fecha UNIQUE (nombre, fecha)
);

CREATE TABLE combo_items (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    combo_id            BIGINT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
    articulo_id         BIGINT NOT NULL REFERENCES articulos(id) ON DELETE RESTRICT,
    cantidad            INTEGER NOT NULL CHECK (cantidad >= 1),
    descripcion         TEXT NOT NULL,
    precio_unitario     NUMERIC(14, 2) NOT NULL CHECK (precio_unitario >= 0),
    CONSTRAINT uq_combo_item UNIQUE (combo_id, articulo_id)
);

COMMENT ON COLUMN combo_items.precio_unitario IS
    'Snapshot del precio al guardar el combo: los cambios laterales no alteran el histórico.';

-- -----------------------------------------------------------------------------
-- 6.5 CLIENTES (entidad normalizada; `pedidos.cliente` queda como snapshot)
-- -----------------------------------------------------------------------------
CREATE TABLE clientes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre      TEXT NOT NULL UNIQUE,
    rut         TEXT,
    razon_social TEXT,
    telefono    TEXT,
    email       TEXT,
    direccion   TEXT,
    notas       TEXT,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_cliente_rut_vacio CHECK (rut IS NULL OR btrim(rut) <> '')
);

-- -----------------------------------------------------------------------------
-- 6.6 FILAMENTO: inventario + movimientos (consumo lo descuenta una medición)
-- -----------------------------------------------------------------------------
CREATE TYPE movimiento_filamento AS ENUM ('entrada', 'consumo', 'ajuste');

CREATE TABLE filamentos (
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

CREATE TABLE movimientos_filamento (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filamento_id  BIGINT NOT NULL REFERENCES filamentos(id) ON DELETE RESTRICT,
    fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
    tipo          movimiento_filamento NOT NULL,
    kg            NUMERIC(10, 3) NOT NULL CHECK (kg <> 0),
    motivo        TEXT,
    medicion_id   BIGINT REFERENCES mediciones_slicer(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE movimientos_filamento IS
    'Libro de inventario: entradas, consumos por medición del slicer y ajustes.';

-- -----------------------------------------------------------------------------
-- 7. PEDIDOS DE CLIENTES (código PED-XXX generado por la base de datos)
-- -----------------------------------------------------------------------------
CREATE TABLE pedidos (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo          TEXT GENERATED ALWAYS AS ('PED-' || lpad(id::TEXT, 3, '0')) STORED NOT NULL UNIQUE,
    fecha           DATE NOT NULL,
    cliente         TEXT NOT NULL,
    cliente_id      BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
    estado          estado_pedido NOT NULL DEFAULT 'Pendiente',
    con_factura     BOOLEAN NOT NULL DEFAULT false,
    rut             TEXT,
    razon_social    TEXT,
    numero_factura  TEXT,
    fecha_factura   DATE,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_numero_factura UNIQUE (numero_factura)
);

COMMENT ON COLUMN pedidos.cliente IS
    'Snapshot del nombre al crear el pedido; el vínculo canónico es cliente_id.';

CREATE TABLE pedido_items (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pedido_id           BIGINT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    tipo                tipo_item_pedido NOT NULL,
    articulo_id         BIGINT REFERENCES articulos(id) ON DELETE RESTRICT,
    combo_id            BIGINT REFERENCES combos(id) ON DELETE RESTRICT,
    descripcion         TEXT NOT NULL,
    cantidad            INTEGER NOT NULL CHECK (cantidad >= 1),
    precio_unitario     NUMERIC(14, 2) NOT NULL CHECK (precio_unitario >= 0),
    CONSTRAINT ck_pedido_item_origen CHECK (
        (tipo = 'articulo' AND articulo_id IS NOT NULL AND combo_id IS NULL) OR
        (tipo = 'combo'    AND combo_id IS NOT NULL    AND articulo_id IS NULL)
    )
);

COMMENT ON CONSTRAINT ck_pedido_item_origen ON pedido_items IS
    'Garantiza que cada línea apunte a exactamente un origen: artículo o combo.';

-- -----------------------------------------------------------------------------
-- 8. ÍNDICES DE CONSULTA
-- -----------------------------------------------------------------------------
CREATE INDEX idx_mediciones_articulo   ON mediciones_slicer(articulo_id);
CREATE INDEX idx_registro_articulo     ON registro_costos(articulo_id);
CREATE INDEX idx_combo_items_combo     ON combo_items(combo_id);
CREATE INDEX idx_pedido_items_pedido   ON pedido_items(pedido_id);
CREATE INDEX idx_pedidos_fecha         ON pedidos(fecha DESC, id DESC);
CREATE INDEX idx_pedidos_estado        ON pedidos(estado);
CREATE INDEX idx_pedidos_cliente       ON pedidos(cliente_id);
CREATE INDEX idx_pedidos_factura       ON pedidos(numero_factura);
CREATE INDEX idx_mov_filamento_fil     ON movimientos_filamento(filamento_id, fecha DESC);

-- -----------------------------------------------------------------------------
-- 9. AUDITORÍA
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_actualizado_en()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.actualizado_en := now();
    RETURN NEW;
END $$;

CREATE TRIGGER trg_parametros_touch
BEFORE UPDATE ON parametros_base
FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

CREATE TRIGGER trg_mediciones_touch
BEFORE UPDATE ON mediciones_slicer
FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

CREATE TRIGGER trg_pedidos_touch
BEFORE UPDATE ON pedidos
FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- -----------------------------------------------------------------------------
-- 10. VISTAS DE LECTURA
-- -----------------------------------------------------------------------------
CREATE VIEW v_catalogo_articulos AS
SELECT a.id, a.codigo, a.nombre,
       a.codigo || ' | ' || a.nombre AS etiqueta
FROM articulos a
ORDER BY a.codigo;

CREATE VIEW v_combos_detalle AS
SELECT c.*,
       COALESCE((
           SELECT string_agg(ci.descripcion || ' x' || ci.cantidad, ', ' ORDER BY ci.id)
           FROM combo_items ci WHERE ci.combo_id = c.id
       ), 'Sin artículos') AS detalle
FROM combos c;

CREATE VIEW v_resumen_pedidos AS
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
-- 10.5 AUTORIZACIÓN (se define antes que las RPC que la invocan)
-- -----------------------------------------------------------------------------
-- Lista blanca: solo estos correos pueden usar la app. Agregá el tuyo.
CREATE TABLE IF NOT EXISTS public.usuarios_autorizados (
    email      TEXT PRIMARY KEY,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.usuarios_autorizados(email)
VALUES ('TU-EMAIL@ejemplo.com')
ON CONFLICT (email) DO NOTHING;

-- Autorización central (la usan las políticas y las RPCs).
-- SECURITY DEFINER para poder consultar la lista aunque RLS esté activo.
CREATE OR REPLACE FUNCTION public.i3d_usuario_autorizado()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT auth.uid() IS NOT NULL
       AND EXISTS (
            SELECT 1 FROM public.usuarios_autorizados ua
            WHERE lower(ua.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       );
$$;

-- -----------------------------------------------------------------------------
-- 11. FUNCIONES RPC TRANSACCIONALES
-- -----------------------------------------------------------------------------

-- 11.1 Obtener o crear artículo (a prueba de concurrencia)
-- IMPORTANTE: se devuelve SETOF articulos (no RETURNS TABLE(id, codigo, nombre))
-- porque esos nombres de salida colisionarían con las columnas de articulos en
-- ON CONFLICT (nombre) → error 42702 "column reference is ambiguous".
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

-- 11.1b Obtener o crear cliente; si existe, completa los datos fiscales que falten
CREATE OR REPLACE FUNCTION api_obtener_o_crear_cliente(
    p_nombre        TEXT,
    p_rut           TEXT DEFAULT NULL,
    p_razon_social  TEXT DEFAULT NULL,
    p_telefono      TEXT DEFAULT NULL,
    p_email         TEXT DEFAULT NULL
)
RETURNS SETOF clientes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id      BIGINT;
    v_limpio  TEXT;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;

    v_limpio := btrim(coalesce(p_nombre, ''));
    IF v_limpio = '' THEN
        RAISE EXCEPTION 'El nombre del cliente no puede estar vacío';
    END IF;

    INSERT INTO clientes(nombre, rut, razon_social, telefono, email)
    VALUES (
        v_limpio,
        nullif(btrim(coalesce(p_rut, '')), ''),
        nullif(btrim(coalesce(p_razon_social, '')), ''),
        nullif(btrim(coalesce(p_telefono, '')), ''),
        nullif(btrim(coalesce(p_email, '')), '')
    )
    ON CONFLICT (nombre) DO UPDATE SET
        rut          = COALESCE(clientes.rut, EXCLUDED.rut),
        razon_social = COALESCE(clientes.razon_social, EXCLUDED.razon_social),
        telefono     = COALESCE(clientes.telefono, EXCLUDED.telefono),
        email        = COALESCE(clientes.email, EXCLUDED.email)
    RETURNING id INTO v_id;

    RETURN QUERY SELECT c.* FROM clientes c WHERE c.id = v_id;
END $$;

-- 11.1c Guardar medición y, si se indicó filamento, descontar el consumo.
-- El consumo se registra solo cuando la medición es NUEVA (no al editarla).
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
DECLARE
    v_id       BIGINT;
    v_existe   BOOLEAN;
    v_kg       NUMERIC(10, 3);
    v_consumo  NUMERIC(10, 3);
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;
    IF coalesce(p_cantidad, 0) < 1 THEN
        RAISE EXCEPTION 'La cantidad debe ser al menos 1';
    END IF;
    IF coalesce(p_gramos, 0) < 0 THEN
        RAISE EXCEPTION 'Los gramos no pueden ser negativos';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM mediciones_slicer
        WHERE articulo_id = p_articulo_id AND cantidad = p_cantidad
    ) INTO v_existe;

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
        IF v_kg IS NULL THEN
            RAISE EXCEPTION 'No existe el filamento indicado';
        END IF;
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

-- 11.1d Dar de alta un filamento con su stock inicial (y su movimiento de entrada)
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
DECLARE
    v_id BIGINT;
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;
    IF btrim(coalesce(p_nombre, '')) = '' OR btrim(coalesce(p_material, '')) = ''
       OR btrim(coalesce(p_color, '')) = '' THEN
        RAISE EXCEPTION 'Nombre, material y color son obligatorios';
    END IF;
    IF coalesce(p_kg_inicial, 0) < 0 THEN
        RAISE EXCEPTION 'El stock inicial no puede ser negativo';
    END IF;

    INSERT INTO filamentos(nombre, material, color, kg_disponibles, kg_alerta,
                           costo_kg, proveedor)
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

-- 11.1e Registrar entrada o ajuste de stock (p_tipo TEXT para evitar acoplamiento al enum)
CREATE OR REPLACE FUNCTION api_mover_filamento(
    p_filamento_id  BIGINT,
    p_tipo          TEXT,
    p_kg            NUMERIC,
    p_motivo        TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_kg    NUMERIC(10, 3);
    v_delta NUMERIC(10, 3);
BEGIN
    IF NOT public.i3d_usuario_autorizado() THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;
    IF coalesce(p_kg, 0) = 0 THEN
        RAISE EXCEPTION 'Ingresá una cantidad de kg distinta de cero';
    END IF;
    IF p_tipo NOT IN ('entrada', 'ajuste') THEN
        RAISE EXCEPTION 'Tipo de movimiento inválido';
    END IF;

    SELECT kg_disponibles INTO v_kg FROM filamentos WHERE id = p_filamento_id FOR UPDATE;
    IF v_kg IS NULL THEN
        RAISE EXCEPTION 'No existe el filamento indicado';
    END IF;

    IF p_tipo = 'entrada' AND p_kg <= 0 THEN
        RAISE EXCEPTION 'Una entrada debe ser positiva';
    END IF;

    v_delta := ROUND(p_kg, 3);
    IF v_kg + v_delta < 0 THEN
        RAISE EXCEPTION 'El movimiento dejaría stock negativo';
    END IF;

    UPDATE filamentos
    SET kg_disponibles = ROUND(kg_disponibles + v_delta, 3)
    WHERE id = p_filamento_id;

    INSERT INTO movimientos_filamento(filamento_id, fecha, tipo, kg, motivo)
    VALUES (p_filamento_id, CURRENT_DATE, p_tipo::movimiento_filamento, v_delta, p_motivo);
END $$;

-- 11.2 Guardar un combo completo (cabecera + ítems) en una sola transacción
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

-- 11.3 Crear un pedido completo (cabecera + ítems) en una sola transacción
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

-- -----------------------------------------------------------------------------
-- 12. SEGURIDAD: Supabase Auth + RLS restrictivo + GRANTS
-- -----------------------------------------------------------------------------
ALTER TABLE parametros_base   ENABLE ROW LEVEL SECURITY;
ALTER TABLE articulos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediciones_slicer ENABLE ROW LEVEL SECURITY;
ALTER TABLE registro_costos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE combos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE combo_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedido_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE filamentos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_filamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios_autorizados ENABLE ROW LEVEL SECURITY;

-- El usuario solo ve su propia fila de autorización.
DROP POLICY IF EXISTS i3d_ver_propia_autorizacion ON public.usuarios_autorizados;
CREATE POLICY i3d_ver_propia_autorizacion ON public.usuarios_autorizados
    FOR SELECT TO authenticated
    USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Las políticas usan la función definida en 10.5.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'parametros_base','articulos','mediciones_slicer','registro_costos',
        'combos','combo_items','pedidos','pedido_items',
        'clientes','filamentos','movimientos_filamento'
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

-- Sin permisos para anon: la publishable key ya no alcanza para leer nada.
REVOKE ALL ON TABLE
    parametros_base, articulos, mediciones_slicer, registro_costos,
    combos, combo_items, pedidos, pedido_items,
    clientes, filamentos, movimientos_filamento, usuarios_autorizados
FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    parametros_base, articulos, mediciones_slicer, registro_costos,
    combos, combo_items, pedidos, pedido_items,
    clientes, filamentos, movimientos_filamento
TO authenticated;
GRANT SELECT ON TABLE usuarios_autorizados TO authenticated;
GRANT EXECUTE ON FUNCTION public.i3d_usuario_autorizado() TO authenticated;

REVOKE ALL ON v_catalogo_articulos, v_combos_detalle, v_resumen_pedidos FROM anon;
GRANT SELECT ON v_catalogo_articulos, v_combos_detalle, v_resumen_pedidos TO authenticated;

-- Se usa la forma sin lista de argumentos para cubrir todas las sobrecargas.
REVOKE ALL ON FUNCTION api_obtener_o_crear_articulo FROM anon;
REVOKE ALL ON FUNCTION api_obtener_o_crear_cliente FROM anon;
REVOKE ALL ON FUNCTION api_guardar_medicion FROM anon;
REVOKE ALL ON FUNCTION api_crear_filamento FROM anon;
REVOKE ALL ON FUNCTION api_mover_filamento FROM anon;
REVOKE ALL ON FUNCTION api_guardar_combo FROM anon;
REVOKE ALL ON FUNCTION api_crear_pedido FROM anon;

GRANT EXECUTE ON FUNCTION api_obtener_o_crear_articulo TO authenticated;
GRANT EXECUTE ON FUNCTION api_obtener_o_crear_cliente TO authenticated;
GRANT EXECUTE ON FUNCTION api_guardar_medicion TO authenticated;
GRANT EXECUTE ON FUNCTION api_crear_filamento TO authenticated;
GRANT EXECUTE ON FUNCTION api_mover_filamento TO authenticated;
GRANT EXECUTE ON FUNCTION api_guardar_combo TO authenticated;
GRANT EXECUTE ON FUNCTION api_crear_pedido TO authenticated;

-- -----------------------------------------------------------------------------
-- 13. DATOS INICIALES (seed idempotente)
-- -----------------------------------------------------------------------------

-- 13.1 Parámetros
INSERT INTO parametros_base (clave, etiqueta, valor, unidad, base, notas) VALUES
('energia_kwh',              'Energía eléctrica',            11.0000, '$ UYU / kWh', 'UYU',
 'Tarifa media UTE residencial / comercial'),
('desgaste_maquina_h',       'Desgaste de máquina',          10.0000, '$ UYU / h',   'UYU',
 'Amortización de equipo, boquillas y mantenimiento'),
('tiempo_manual_h',          'Mano de obra',                250.0000, '$ UYU / h',   'UYU',
 'Preparación, calibración y post-procesado'),
('precio_plastico_usd_kg',   'Plástico (USD / kg)',          15.0000, 'USD / kg',    'USD',
 'Bobina estándar PLA / PETG en plaza local'),
('consumo_maquina_w',        'Consumo de impresora',        110.0000, 'W',           'W',
 'Potencia media de la impresora 3D'),
('factor_defecto',           'Factor multiplicador',          2.5000, 'x',           'Ratio',
 'Multiplicador estándar sobre costo base'),
('cotizacion_dolar',         'Cotización dólar (venta)',     41.5000, '$ UYU / USD', 'UYU',
 'Tipo de cambio de referencia editable')
ON CONFLICT (clave) DO NOTHING;

-- 13.1b Clientes de ejemplo
INSERT INTO clientes (nombre, rut, razon_social, telefono, email) VALUES
('Juan Pérez',         '1.234.567-8', 'Juan Pérez',        '091 123 456', 'juan@example.com'),
('Lucía Silva',        '2.345.678-9', 'Lucía Silva',       '092 234 567', 'lucia@example.com'),
('Martín Rodríguez',   '3.456.789-1', 'Martín Rodríguez',  '093 345 678', 'martin@example.com'),
('Valentina Gómez',    '4.567.890-2', 'Valentina Gómez',   '094 456 789', 'valentina@example.com'),
('Tech Solutions UY',  '5.678.901-3', 'Tech Solutions SRL','095 567 890', 'contacto@techuy.com'),
('Estudio Creativo',   '6.789.012-4', 'Estudio Creativo',  '096 678 901', 'hola@estudiocreativo.uy')
ON CONFLICT (nombre) DO NOTHING;

-- 13.1c Filamentos de ejemplo
INSERT INTO filamentos (nombre, material, color, kg_disponibles, kg_alerta, costo_kg, proveedor)
VALUES
('PLA Negro',   'PLA',  'Negro',  2.400, 0.500, 18.00, 'Local 3D'),
('PLA Blanco',  'PLA',  'Blanco', 1.100, 0.500, 18.00, 'Local 3D'),
('PETG Azul',   'PETG', 'Azul',   0.350, 0.500, 22.50, 'Impresora UY')
ON CONFLICT (material, color) DO NOTHING;

INSERT INTO movimientos_filamento (filamento_id, fecha, tipo, kg, motivo)
SELECT f.id, CURRENT_DATE, 'entrada', f.kg_disponibles, 'Stock inicial'
FROM filamentos f
WHERE NOT EXISTS (SELECT 1 FROM movimientos_filamento m WHERE m.filamento_id = f.id);

-- 13.2 Artículos (los códigos ART-001..006 se generan solos)
INSERT INTO articulos (nombre) VALUES
('Mate Autocebante'),
('Fidget Manzana'),
('Fidget Hexagonal'),
('Fidget Cubo Infinito'),
('Fidget Bola'),
('Llavero Sindicato')
ON CONFLICT (nombre) DO NOTHING;

-- 13.3 Mediciones reales del slicer
INSERT INTO mediciones_slicer
(fecha, articulo_id, cantidad, gramos_lote, horas_impresion_lote,
 horas_preparacion_lote, horas_postprocesado_unit, factor)
SELECT v.fecha, a.id, v.cant, v.gramos, v.imp, v.prep, v.post, v.factor
FROM (VALUES
 (DATE '2024-05-15','ART-001',1,  45.00,  2.500000, 0.250000, 0.100000, 1.50),
 (DATE '2026-11-13','ART-002',1,  19.70,  1.233333, 0.083333, 0.000000, 2.50),
 (DATE '2026-11-13','ART-003',1,  44.08,  1.616667, 0.083333, 0.000000, 3.00),
 (DATE '2026-11-13','ART-004',1,  28.16,  1.383333, 0.083333, 0.000000, 2.00),
 (DATE '2026-11-14','ART-005',1,  77.89,  4.300000, 0.083333, 0.000000, 2.00),
 (DATE '2026-11-14','ART-001',5, 225.00, 12.500000, 0.250000, 0.100000, 1.50),
 (DATE '2026-11-14','ART-005',3, 233.55, 12.350000, 0.083333, 0.000000, 2.00),
 (DATE '2026-11-14','ART-006',13, 73.31,  5.333333, 0.083333, 0.000000, 2.00)
) AS v(fecha, codigo, cant, gramos, imp, prep, post, factor)
JOIN articulos a ON a.codigo = v.codigo
ON CONFLICT (articulo_id, cantidad) DO NOTHING;

-- 13.4 Registro de costos
INSERT INTO registro_costos (articulo_id, cantidad, factor)
SELECT a.id, v.cant, v.factor
FROM (VALUES
 ('ART-001', 1, 1.50),
 ('ART-002', 1, 2.50),
 ('ART-003', 1, 3.00),
 ('ART-004', 1, 3.00),
 ('ART-005', 3, 1.50),
 ('ART-006',13, 3.00)
) AS v(codigo, cant, factor)
JOIN articulos a ON a.codigo = v.codigo
ON CONFLICT (articulo_id, cantidad) DO NOTHING;

-- 13.5 Combos guardados (snapshots)
INSERT INTO combos
(fecha, nombre, presupuesto, opcion, composicion, precio_venta, costo_produccion, saldo, estado)
VALUES
(DATE '2026-11-13', 'Combo Variado Mix', 3278.00,
 'Opción 2 (Máx. Cantidad)',
 'Fidget Cubo Infinito (ART-004) x8, Fidget Manzana (ART-002) x7, Mate Autocebante (ART-001) x5, Fidget Hexagonal (ART-003) x3',
 3273.89, 1676.82, 4.11, '✅ Guardado'),
(DATE '2026-11-13', 'Pack Fidgets Alta Rentabilidad', 3278.00,
 'Opción 3 (Máx. Ganancia)',
 'Fidget Manzana (ART-002) x11, Fidget Hexagonal (ART-003) x5, Fidget Cubo Infinito (ART-004) x11',
 3269.78, 1440.69, 8.22, '✅ Guardado')
ON CONFLICT (nombre, fecha) DO NOTHING;

INSERT INTO combo_items (combo_id, articulo_id, cantidad, descripcion, precio_unitario)
SELECT c.id, a.id, v.cant, v.descripcion, v.precio
FROM (VALUES
 ('Combo Variado Mix',           'ART-004', 8,  'Fidget Cubo Infinito', 161.61::NUMERIC),
 ('Combo Variado Mix',           'ART-002', 7,  'Fidget Manzana',       117.30::NUMERIC),
 ('Combo Variado Mix',           'ART-001', 5,  'Mate Autocebante',     215.31::NUMERIC),
 ('Combo Variado Mix',           'ART-003', 3,  'Fidget Hexagonal',     199.20::NUMERIC),
 ('Pack Fidgets Alta Rentabilidad','ART-002',11, 'Fidget Manzana',       117.30::NUMERIC),
 ('Pack Fidgets Alta Rentabilidad','ART-003', 5,  'Fidget Hexagonal',     199.20::NUMERIC),
 ('Pack Fidgets Alta Rentabilidad','ART-004',11, 'Fidget Cubo Infinito', 161.61::NUMERIC)
) AS v(combo_nombre, codigo, cant, descripcion, precio)
JOIN combos c   ON c.nombre  = v.combo_nombre
JOIN articulos a ON a.codigo = v.codigo
WHERE NOT EXISTS (
    SELECT 1 FROM combo_items ci
    WHERE ci.combo_id = c.id AND ci.articulo_id = a.id
);

-- 13.6 Pedidos (vinculados al cliente por nombre)
INSERT INTO pedidos (fecha, cliente, cliente_id, estado)
SELECT v.fecha, v.cliente, c.id, v.estado
FROM (VALUES
 (DATE '2024-05-18', 'Juan Pérez',        'Entregado'::estado_pedido),
 (DATE '2024-05-20', 'Lucía Silva',       'En Producción'::estado_pedido),
 (DATE '2024-05-22', 'Martín Rodríguez',  'Pendiente'::estado_pedido),
 (DATE '2024-05-25', 'Valentina Gómez',   'Listo para Entrega'::estado_pedido),
 (DATE '2024-05-28', 'Tech Solutions UY', 'Entregado'::estado_pedido),
 (DATE '2024-05-30', 'Estudio Creativo',  'En Producción'::estado_pedido)
) AS v(fecha, cliente, estado)
JOIN clientes c ON c.nombre = v.cliente
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO pedido_items (pedido_id, tipo, articulo_id, descripcion, cantidad, precio_unitario)
SELECT p.id, 'articulo', a.id, v.descripcion, v.cant, v.precio
FROM (VALUES
 ('PED-001','ART-001','Mate Autocebante',     2, 215.31::NUMERIC),
 ('PED-002','ART-003','Fidget Hexagonal',     5, 199.20::NUMERIC),
 ('PED-003','ART-006','Llavero Sindicato',   20,  28.92::NUMERIC),
 ('PED-004','ART-004','Fidget Cubo Infinito', 3, 161.61::NUMERIC),
 ('PED-005','ART-002','Fidget Manzana',      10, 117.30::NUMERIC),
 ('PED-006','ART-005','Fidget Bola',          4, 151.92::NUMERIC)
) AS v(codigo_pedido, codigo_articulo, descripcion, cant, precio)
JOIN pedidos p   ON p.codigo  = v.codigo_pedido
JOIN articulos a ON a.codigo = v.codigo_articulo
WHERE NOT EXISTS (SELECT 1 FROM pedido_items pi WHERE pi.pedido_id = p.id);

COMMIT;

-- =============================================================================
-- FIN DEL SCHEMA v2
-- =============================================================================
