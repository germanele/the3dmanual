-- =============================================================================
-- PARCHE RPC — api_obtener_o_crear_articulo
-- -----------------------------------------------------------------------------
-- Error corregido: 42702 "column reference ""nombre"" is ambiguous"
--
-- CAUSA: la función declaraba RETURNS TABLE(id, codigo, nombre), lo que crea
-- variables de salida con esos mismos nombres. Al ejecutar
-- ON CONFLICT (nombre), PostgreSQL no sabía si "nombre" era la columna de
-- articulos o la variable OUT → error en tiempo de ejecución.
--
-- SOLUCIÓN: devolver SETOF articulos. Así no hay variables OUT que colisionen
-- y el JSON resultante mantiene las claves id / codigo / nombre que usa db.js.
--
-- ⚠️ Esto NO borra ningún dato. Solo reemplaza esa función.
-- Ejecutar en: Supabase → SQL Editor → New query → Run.
-- =============================================================================

DROP FUNCTION IF EXISTS api_obtener_o_crear_articulo(TEXT) CASCADE;

CREATE OR REPLACE FUNCTION api_obtener_o_crear_articulo(p_nombre TEXT)
RETURNS SETOF articulos
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_limpio TEXT;
    v_id     BIGINT;
BEGIN
    -- Acepta tanto "Nombre" como "ART-001 | Nombre"
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

-- El DROP ... CASCADE también eliminó los permisos: los restauramos.
GRANT EXECUTE ON FUNCTION api_obtener_o_crear_articulo(TEXT) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- Verificación rápida (opcional): debe devolver ART-001 sin insertar nada nuevo
-- -----------------------------------------------------------------------------
-- SELECT * FROM api_obtener_o_crear_articulo('Mate Autocebante');
