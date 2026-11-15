# Gestión Impresión 3D — Costos, Cotizador y Combos (Uruguay)

Aplicación web ejecutada 100% en el navegador con **SQLite real (WebAssembly via `sql.js`)**, pre-cargada con todos los datos y fórmulas convertidas del archivo `Gestión Impresión 3D - Costos y Combos (Uruguay).xlsx`.

## Contenido del Paquete
- `index-standalone.html`: Versión autocontenida (HTML + CSS + JS + SQLite Seed). Se puede abrir haciendo **doble clic directo** sin instalar nada ni levantar un servidor.
- `index.html`, `styles.css`, `engine.js`, `db.js`, `app.js`: Versión modular separada por capas (Interfaz, Motor de Fórmulas Excel y Persistencia SQLite).
- `gestion_3d.sqlite`: Archivo binario SQLite real pre-poblado con las tablas y registros del Excel.

## Cómo Implementarlo

### Opción A: Ejecución Instantánea (Sin Servidor)
1. Descomprimí el archivo ZIP.
2. Hacé **doble clic en `index-standalone.html`** para abrirlo en Chrome, Edge, Firefox o Brave.
3. Todos los cambios (agregar, modificar o eliminar registros) se guardan en tiempo real en la base SQLite en memoria y se persisten automáticamente en `localStorage`.

### Opción B: Servidor Local o Hosting Estático (Versión Modular)
1. Abrí una terminal en la carpeta descomprimida y ejecutá cualquiera de estos comandos:
   - **Python**: `python -m http.server 8080`
   - **Node.js**: `npx serve .`
   - **VS Code**: Clic derecho en `index.html` -> *Open with Live Server*.
2. Abrí `http://localhost:8080` en tu navegador.
3. Podés descargar el archivo `.sqlite` actualizado en cualquier momento desde el botón **Exportar .sqlite** o cargar `gestion_3d.sqlite` con **Importar .sqlite**.
