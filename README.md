# Gestión Impresión 3D — Costos, Cotizador y Combos (Uruguay) | Supabase

Aplicación web migrada de SQLite local a **Supabase (PostgreSQL)** en la nube.

## Contenido del Paquete
- `supabase_schema.sql`: Script SQL completo para crear todas las tablas, triggers, vistas, políticas RLS y datos iniciales (seed) en PostgreSQL/Supabase.
- `index.html`: Interfaz web conectada mediante CDN al SDK oficial `@supabase/supabase-js@2`.
- `db.js`: Capa de acceso a datos asíncrona (`async/await`) contra Supabase.
- `app.js`: Controlador de interfaz actualizado para operaciones asíncronas en tiempo real.
- `engine.js`: Motor matemático de cálculo de costos, escalas y combos (sin cambios).
- `styles.css`: Hojas de estilo de la aplicación.

## Pasos para Ponerlo en Marcha

### 1. Configurar la Base de Datos en Supabase
1. Ingresá a tu proyecto en [Supabase](https://supabase.com/).
2. Andá a la sección **SQL Editor** -> **New query**.
3. Copiá y pegá todo el contenido del archivo `supabase_schema.sql` y ejecutalo (**Run**). Esto creará las tablas y cargará los datos iniciales.

### 2. Configurar tus Credenciales en `db.js`
1. En tu panel de Supabase, andá a **Project Settings** -> **API**.
2. Copiá tu **Project URL** y tu **anon / public key**.
3. Abrí `db.js` y reemplazá las constantes en las primeras líneas:
   ```javascript
   const SUPABASE_URL = 'https://tu-proyecto.supabase.co';
   const SUPABASE_ANON_KEY = 'tu-anon-key-aqui';
   ```

### 3. Ejecutar la Aplicación Web
Abrí una terminal en la carpeta del proyecto y levantá un servidor local (o subilo a Vercel/Netlify/GitHub Pages):
- **Python**: `python -m http.server 8080`
- **Node.js**: `npx serve .`
- **VS Code**: Clic derecho en `index.html` -> *Open with Live Server*.
