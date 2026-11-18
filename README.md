# PrintLab 3D — v2

Versión propia de la aplicación de gestión de impresión 3D (Uruguay), con la
**base de datos reconstruida desde cero** en PostgreSQL / Supabase.

Conserva la lógica y el propósito del original:

- **Catálogo y costos** con semáforo N=1 (medición real vs. piso estimado).
- **Cotizador dinámico** por cantidad, con tabla de escalas y curva costo/precio.
- **Armador de combos** por presupuesto (3 estrategias + armado manual).
- **Clientes y pedidos** multi-artículo / multi-combo con estados y KPIs.
- **Mediciones reales del slicer** (BambuStudio) con tiempos `hh:mm`.
- **Parámetros base** editables que recalculan toda la aplicación.

---

## Qué cambió en la base de datos

| Original (v1) | Nuevo esquema (v2) |
|---|---|
| `fecha TEXT` | `DATE` con validación real |
| `REAL` para dinero | `NUMERIC(14,2)` (sin errores de coma flotante) |
| IDs `ART-XXX` / `PED-XXX` generados en JavaScript | `IDENTITY` + columna generada en PostgreSQL (sin carreras) |
| `pedido_items.ref_id TEXT` polimórfico | FKs reales `articulo_id` / `combo_id` + `CHECK` de origen exclusivo |
| Combo = texto desnormalizado | `combos` + `combo_items` (snapshot estructurado) |
| Upsert de mediciones simulado en la app | `UNIQUE (articulo_id, cantidad)` + `ON CONFLICT` real |
| `estado TEXT` libre | `ENUM estado_pedido` controlado por la BD |
| Sin auditoría | `creado_en` / `actualizado_en` + trigger |
| Inserción de pedido en 2 consultas | RPC `api_crear_pedido` transaccional |
| RLS permisivo sin grants explícitos | RLS por tabla + grants mínimos para `anon` / `authenticated` |

Tablas nuevas: `parametros_base`, `articulos`, `mediciones_slicer`,
`registro_costos`, `combos`, `combo_items`, `pedidos`, `pedido_items`.

---

## Instalación

### 1. Recrear la base de datos

1. Entrá a [Supabase](https://supabase.com/) y abrí tu proyecto.
2. **SQL Editor → New query**.
3. Pegá todo `supabase_schema.sql` y ejecutalo (**Run**).

> ⚠️ El script **elimina las tablas anteriores y sus datos** y vuelve a cargar
> los datos de ejemplo. Es una reconstrucción desde cero, como pediste.

### 2. Configurar credenciales

Editá `config.js` con los valores de **Project Settings → API** de tu proyecto:

```js
window.APP_CONFIG = {
  url: 'https://TU-PROYECTO.supabase.co',
  anonKey: 'TU-PUBLISHABLE-KEY'
};
```

### 3. Abrir la aplicación

Cualquier servidor estático sirve (los CDNs requieren `http://`):

```bash
python -m http.server 8080
# o
npx serve .
```

Visitá `http://localhost:8080`. En la esquina superior derecha debe aparecer
**🟢 Supabase conectado**. Si sale rojo, revisá `config.js` y que el SQL haya
corrido sin errores.

---

## Estructura de archivos

```
gestion_impresion_3d_v2/
├── supabase_schema.sql   ← BD nueva: tipos, tablas, índices, RPC, RLS y seed
├── config.js             ← URL y clave pública de Supabase
├── engine.js             ← motor de cálculo (fórmulas, hh:mm, combos, punto de equilibrio)
├── db.js                 ← capa de persistencia y adaptadores al modelo de vista
├── app.js                ← controlador: estado central, render por módulo, eventos
├── index.html            ← interfaz de los 6 módulos
└── styles.css            ← diseño responsive
```

---

## Notas

- Los códigos `ART-001`, `PED-001`, etc. los genera PostgreSQL; no se editan.
- Guardar un combo congela sus precios (`combo_items.precio_unitario`), para que
  el histórico no cambie si después se modifican los parámetros.
- Crear un pedido inserta cabecera e ítems en **una sola transacción**.
- Las políticas RLS son abiertas para `anon`/`authenticated` porque la demo no
  tiene login. Si agregás autenticación, reemplazá `USING (true)` por una
  condición sobre `auth.uid()`.
