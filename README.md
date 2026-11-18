# PrintLab 3D — v2

Versión propia de la aplicación de gestión de impresión 3D (Uruguay), con la
**base de datos reconstruida desde cero** en PostgreSQL / Supabase.

Conserva la lógica y el propósito del original:

- **Catálogo y costos** con semáforo N=1 (medición real vs. piso estimado).
- **Cotizador dinámico** por cantidad, con tabla de escalas y curva costo/precio.
- **Armador de combos** por presupuesto (3 estrategias + armado manual).
- **Clientes** con ficha, datos fiscales y cantidad de pedidos.
- **Pedidos** multi-artículo / multi-combo con estados y KPIs.
- **Mediciones reales del slicer** (BambuStudio) con tiempos `hh:mm`.
- **Inventario de filamento** con bobinas, stock, alertas y movimientos.
- **Parámetros base** editables que recalculan toda la aplicación.

La interfaz tiene **8 módulos/pestañas**, separados para que cada área tenga su
propio espacio. `Mediciones` sigue teniendo el selector de filamento para
descontar consumo; el alta y el libro de movimientos viven en `Inventario de
filamento`.

### Novedades

- **Facturación con IVA**: cada pedido tiene un interruptor *Con factura*.
  Al activarlo se suma **22 % de IVA** al precio final, con desglose de
  subtotal, IVA y total tanto en el borrador como en el historial. La cartera
  muestra **Subtotal** (sin IVA) y **Total** (con IVA); si el pedido es sin
  factura, ambas columnas son iguales. El cambio se puede hacer también
  después de creado el pedido, desde la tabla.
- **Acceso privado**: login con Supabase Auth + lista blanca de correos y RLS
  restrictivo. La clave *publishable* sigue siendo pública (es normal), pero sin
  sesión la BD no devuelve ningún dato.
- **Clientes con datos fiscales**: cada cliente guarda RUT, razón social,
  teléfono, email, dirección y notas. Al facturar, el pedido copia RUT y razón
  social y permite cargar número y fecha de factura. Todo queda en el módulo
  **Clientes**, separado de **Pedidos**.
- **Inventario de filamento**: módulo propio con bobinas, kg disponibles, alerta
  y costo por kg, más sus **últimos movimientos**. Al guardar una medición nueva
  podés elegir una bobina: el consumo (gramos / 1000) se descuenta en la misma
  transacción y queda registrado en el libro de entradas, consumos y ajustes.
- **Borrados confirmados**: reemplazamos los `confirm()` del navegador por un
  modal propio. Al borrar un pedido podés elegir **anularlo** (marca *Cancelado*
  y conserva el histórico) o **eliminarlo** definitivamente.
- **Menú lateral fijo**: los 8 módulos viven en una barra a la izquierda que
  permanece visible al desplazarte por las tablas largas. En pantallas chicas se
  reduce a iconos para no robar espacio.

> Orden de migraciones sobre una BD ya existente:
> `migration_factura.sql` → `auth_rls.sql` → `mejoras.sql`.
> Ninguna borra datos. `supabase_schema.sql` es solo para reconstruir desde cero.

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
| RLS permisivo sin grants explícitos | RLS por tabla + Supabase Auth + lista blanca de correos; `anon` sin permisos |

Tablas: `parametros_base`, `articulos`, `mediciones_slicer`,
`registro_costos`, `combos`, `combo_items`, `pedidos`, `pedido_items`,
`clientes`, `filamentos`, `movimientos_filamento`, `usuarios_autorizados`.

---

## Instalación

### 1. Recrear la base de datos

1. Entrá a [Supabase](https://supabase.com/) y abrí tu proyecto.
2. **SQL Editor → New query**.
3. Pegá todo `supabase_schema.sql` y ejecutalo (**Run**).

> ⚠️ El script **elimina las tablas anteriores y sus datos** y vuelve a cargar
> los datos de ejemplo. Es una reconstrucción desde cero, como pediste.

> Si **ya tenés la BD v2 funcionando**, no vuelvas a ejecutar el schema completo.
> Corré, en este orden y sin borrar datos:
> 1. `migration_factura.sql` → columna `con_factura`, RPC de pedidos y vista.
> 2. `auth_rls.sql` → login, lista blanca y RLS (reaplica el fix de
>    `api_obtener_o_crear_articulo`).
> 3. `mejoras.sql` → clientes, datos fiscales, filamentos y movimientos.
>
> Si reconstruiste la BD con `supabase_schema.sql` actualizado, los tres pasos ya
> están incluidos y no hace falta correr las migraciones.

### 2. Activar el acceso privado (login + RLS)

Habilitá el login y cerrá la BD para que solo vos puedas entrar:

1. **Authentication → Providers → Email**: habilitado (y desactivá *Confirm email*
   si querés entrar sin verificar el correo, o dejalo activo para más seguridad).
2. **Authentication → Users → Add user**: creá tu usuario con email y contraseña.
3. Editá `auth_rls.sql` y reemplazá `TU-EMAIL@ejemplo.com` por ese email
   (si ya figurás con tu dirección, verificá que sea la correcta).
4. **SQL Editor → New query → Run** con todo `auth_rls.sql`. No borra datos.
5. Recién después corré `mejoras.sql` (usa la función de autorización creada
   en el paso anterior).

> Esto crea la tabla `usuarios_autorizados`, reemplaza la política abierta por
> `i3d_acceso_autenticado` y les quita todos los permisos al rol `anon`.
> Para agregar otro usuario después:
> `INSERT INTO public.usuarios_autorizados(email) VALUES ('otro@email.com');`

### 3. Configurar credenciales

Editá `config.js` con los valores de **Project Settings → API** de tu proyecto:

```js
window.APP_CONFIG = {
  url: 'https://TU-PROYECTO.supabase.co',
  anonKey: 'TU-PUBLISHABLE-KEY'
};
```

### 4. Abrir la aplicación

Cualquier servidor estático sirve (los CDNs requieren `http://`):

```bash
python -m http.server 8080
# o
npx serve .
```

Visitá `http://localhost:8080`. Primero aparece la pantalla de login; al entrar
con tu usuario, la esquina superior derecha debe mostrar **🟢 Supabase conectado**
y tu email. Si sale rojo, revisá `config.js`, que el SQL haya corrido sin errores
y que tu email esté en `usuarios_autorizados`.

---

## Publicar en Cloudflare Pages (gratis)

1. **Subí los archivos a un repo de GitHub** (aunque antes usaras Pages u otro
   hosting): creá un repo nuevo y hacé commit de **todos** los archivos de esta
   carpeta (`index.html`, `config.js`, `engine.js`, `db.js`, `app.js`,
   `styles.css` y los `.sql`, incluido `mejoras.sql`).
2. Entrá a [Cloudflare Dashboard](https://dash.cloudflare.com/) →
   **Workers & Pages → Create → Pages → Connect to Git**.
3. Elegí tu cuenta de GitHub y el repo. En *Build settings*:
   - **Framework preset:** `None`
   - **Build command:** (vacío)
   - **Build output directory:** `/` (la raíz, porque `index.html` está ahí)
4. **Save and Deploy**. En ~1 minuto te dan una URL tipo
   `https://printlab-3d.pages.dev`.
5. **Dominio propio (opcional):** en la pestaña *Custom domains* → *Add custom
   domain*, poné `tudominio.com` y seguís las instrucciones de DNS (Cloudflare
   lo configura automáticamente si el dominio está en Cloudflare).

> Cloudflare no ejecuta tu SQL: eso ya quedó hecho en Supabase. Solo sirve los
> archivos estáticos por HTTPS. El login de Supabase funciona igual porque el
> proyecto permite el origen de `*.pages.dev` (si tenés restricción de orígenes,
> agregá tu dominio en **Authentication → URL Configuration → Redirect URLs**).

**TL;DR de seguridad:** la clave `sb_publishable_...` es pública por diseño y
puede quedarse en `config.js`. Lo que protege tus datos es el login + RLS: sin
sesión, `anon` no puede leer ni escribir nada.

---

## Estructura de archivos

```
gestion_impresion_3d_v2/
├── supabase_schema.sql   ← BD nueva: tipos, tablas, índices, RPC, RLS y seed
├── fix_rpc.sql           ← parche puntual si ya aplicaste el schema antes del fix
├── migration_factura.sql ← migra una BD v2 existente: con_factura + IVA 22 %
├── auth_rls.sql          ← login + lista blanca + RLS restrictivo (no borra datos)
├── mejoras.sql           ← clientes, datos fiscales, filamentos y movimientos (no borra datos)
├── config.js             ← URL y clave pública de Supabase
├── engine.js             ← motor de cálculo (fórmulas, hh:mm, IVA, combos, equilibrio)
├── db.js                 ← capa de persistencia y adaptadores al modelo de vista
├── app.js                ← controlador: estado central, render por módulo, eventos
├── index.html            ← interfaz de los 8 módulos
└── styles.css            ← diseño responsive
```

---

## Notas

- Los códigos `ART-001`, `PED-001`, etc. los genera PostgreSQL; no se editan.
- Guardar un combo congela sus precios (`combo_items.precio_unitario`), para que
  el histórico no cambie si después se modifican los parámetros.
- Crear un pedido inserta cabecera e ítems en **una sola transacción**.
- El IVA se calcula en `NUMERIC` dentro de PostgreSQL y en `Calc.conIVA()` en la
  app; ambos usan redondeo a 2 decimales para que coincidan siempre.
- El acceso es privado: `anon` no tiene permisos; solo usuarios autenticados y
  presentes en `usuarios_autorizados` pueden leer/escribir, tanto por RLS como
  dentro de las RPC (`SECURITY DEFINER`).

### Solución de problemas

- **`column reference "nombre" is ambiguous` al agregar un artículo**:
  versión antigua de `api_obtener_o_crear_articulo`. Ejecutá `fix_rpc.sql` en el
  SQL Editor. No borra datos. `supabase_schema.sql` ya viene corregido.
- **`column articulos.id_articulo does not exist`**: la app v1 está hablándole
  a la BD v2. Publicá los archivos de esta carpeta, no los de la versión anterior.
- **`getElementById(...) is null` en `app.js:1121`**: quedó el `app.js` v1 junto
  al `index.html` v2. Reemplazá todos los archivos y recargá con Ctrl+F5.
- **`Could not find the function public.api_crear_pedido(...)` o falta
  `con_factura`**: no ejecutaste `migration_factura.sql`. Corré ese archivo en
  el SQL Editor (no borra datos) y recargá.
- **Faltan `clientes`, `filamentos` o `movimientos_filamento`**: corré
  `mejoras.sql` (después de `auth_rls.sql`). No borra datos.
- **`No autorizado` al guardar una medición o un pedido**: tu email no está en
  `usuarios_autorizados`, o no corriste `auth_rls.sql`/`mejoras.sql`.
