Tus **datos personales** viven en una base de datos local del dispositivo.
Nunca se envían a un servidor. Para llevarlos de un dispositivo a otro o
guardar una copia de seguridad, la app admite exportar e importar.

## Qué hay en la copia de seguridad

Un archivo de copia de seguridad incluye todo lo personal:

- Tu lista y el orden de las pistas en ella.
- El progreso de escucha de cada pista y qué pistas has terminado.
- Notas y marcadores.
- Los registros de pistas descargadas.
- Los filtros de búsqueda guardados.

Una copia de seguridad **no** incluye el catálogo de clases en sí — eso viene
del servidor de contenido. Después de importar en un dispositivo nuevo, la
app descargará el catálogo automáticamente.

## Exportar

1. Abre **Ajustes → Datos → Exportar datos del usuario**.
2. En un teléfono se abre la hoja de compartir del sistema — elige dónde
   guardar (nube, correo, Archivos, etc.). En la web, el navegador inicia una
   descarga.
3. El archivo es una base de datos SQLite normal.

Puedes exportar tantas veces como quieras — exportar no cambia nada en la app.

## Importar

1. Abre **Ajustes → Datos → Importar datos del usuario**.
2. Elige un archivo `.db` exportado previamente.
3. Confirma el diálogo de reemplazo. La app detiene el reproductor, reemplaza
   cada tabla del usuario por lo que hay en el archivo y se recarga.

> **Atención.** Importar **reemplaza** los datos existentes — la lista, las
> notas, las descargas y el progreso que tienes ahora en la app se
> sobrescribirán. No hay forma de deshacerlo. Exporta primero el estado
> actual si quieres conservarlo.

## Borrar caché vs. borrar datos del usuario

En la **Zona de peligro** (visible solo después de desbloquear la sección de
depuración) encontrarás dos opciones destructivas fáciles de confundir:

- **Borrar caché** elimina todo el audio y las transcripciones descargados. No
  toca tu lista, tus notas ni tu progreso de escucha.
- **Borrar datos del usuario** borra todas las tablas personales — el mismo
  efecto que una instalación nueva. El catálogo de clases se mantiene.

Exporta siempre antes de borrar los datos del usuario.
