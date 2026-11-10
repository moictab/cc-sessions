# CC Sessions

[English](README.md) · **Español**

Todas tus sesiones de Claude Code en una sola ventana. Cada sesión es una terminal real con `claude` dentro, y la app sabe en todo momento cuál está trabajando, cuál necesita permiso, cuál te hace una pregunta y cuál ha terminado. Al cerrar se guarda todo y al volver a abrir se retoma tal cual.

> Proyecto no oficial, sin relación con Anthropic. «Claude» y «Claude Code» son marcas de Anthropic. La app se apoya en algunos formatos internos de Claude Code (el registro de sesiones y los mensajes entre sesiones) que pueden cambiar sin aviso.

## Instalar

Necesitas Windows 11, [Node.js](https://nodejs.org/) 20 o superior (con npm) y [Claude Code](https://docs.claude.com/en/docs/claude-code) instalado, ya sea en `~/.local/bin/claude.exe`, en el PATH o indicado con la variable `CC_SESSIONS_CLAUDE`.

```powershell
git clone https://github.com/moictab/cc-sessions.git
cd cc-sessions
npm install
npm start
```

`npm install` descarga Electron, unos 100 MB. No compila nada: la parte nativa (`node-pty`) trae binarios ya hechos para Windows x64.

La primera vez que arranca, la app crea el acceso **CC Sessions** en el menú Inicio. Desde entonces se abre desde ahí, como cualquier otra aplicación. Windows necesita ese acceso para mostrar sus notificaciones.

### Actualizar

Cierra la app y ejecuta:

```powershell
git pull
npm install
```

Al volver a abrirla tendrás la versión nueva. Tus sesiones y ajustes se guardan aparte, en `%APPDATA%\cc-sessions`, así que no se pierden. Las versiones anteriores usaban `%APPDATA%\cc-session-manager`: la app mueve esa carpeta sola la primera vez.

### Desinstalar

Cierra la app, borra la carpeta del repo y ejecuta esto en PowerShell:

```powershell
$programs = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
Remove-Item "$programs\CC Sessions.lnk"
Remove-Item -Force "$programs\Electron.lnk"   # oculto (ver abajo); sáltatelo si otra app Electron tuya lo usa
Remove-Item -Recurse "HKCU:\Software\Classes\CLSID\{BCF46518-8493-477A-95C6-86BB944559F2}"   # notificaciones
Remove-Item -Recurse "$env:APPDATA\cc-sessions"   # tus sesiones y ajustes; opcional
```

### El acceso oculto `Electron.lnk`

Al mostrar su primera notificación, Electron crea por su cuenta un acceso en el menú Inicio con el nombre de producto de su ejecutable, `Electron.lnk`, y el menú Inicio pasaría a mostrar la app como «Electron». Para evitarlo, la app crea ese archivo ella misma al arrancar, ya válido para que Electron no lo toque y oculto para que el menú Inicio lo ignore. Como el nombre es el mismo para cualquier app Electron sin empaquetar, si desarrollas otras apps Electron el acceso puede acabar apuntando a la última que mostró una notificación. Electron también registra el comando que Windows ejecuta al pulsar una notificación antigua con la app cerrada (la clave `CLSID` de arriba), pero sin la carpeta de la app; la app se la añade.

## Icono

Un prompt `>_` con tres luces de estado (tu turno, necesita permiso, trabajando), en los colores de la app. Se dibuja por código en `scripts/build-icon.js`, y `npm run icon` regenera `assets/icon.ico`, `icon.png`, `icon.svg` y `mark.svg` (la versión pequeña de la barra lateral). Hasta 32 px el dibujo se ajusta a píxeles enteros para que se vea nítido.

## Qué hace

- **Estado en vivo de cada sesión**: Iniciando, Lista, Trabajando, **Necesita permiso** (con la herramienta y el comando concretos), **Te pregunta** (con el texto de la pregunta), **Tu turno** (con el principio de la respuesta), Interrumpida y Cerrada. Cada estado tiene su propia animación en el indicador:

  | Estado | Indicador |
  |---|---|
  | Iniciando | Spinner de braille, como una terminal cargando |
  | Lista | Punto gris quieto |
  | Trabajando | Los mismos glifos que el spinner de Claude Code (`· ✢ ✳ ✶ ✻ ✽`), y el texto «Trabajando» con un brillo que lo recorre |
  | Necesita permiso | Punto ámbar que late, con una onda |
  | Te pregunta | Una `?` violeta que se tambalea, con una onda |
  | Tu turno | Punto verde que aparece con un estallido; brilla mientras no hayas mirado esa sesión |
  | Interrumpida | Barras de pausa ámbar |
  | Cerrada | Anillo hueco |

  Las animaciones se ven aunque tengas desactivados los efectos de animación de Windows, porque aquí el movimiento es la información. Se pueden apagar en Ajustes → Interfaz → «Animar los indicadores de estado».
- **Insignias**: cada sesión tiene una insignia de color con sus iniciales (CS, PE…) en la lista, la barra superior y la cuadrícula. Los colores se reparten para que no se repitan (hasta 12); se cambian con clic derecho → Color.
- **Lista organizada**: las sesiones que te necesitan (un permiso, una pregunta o un turno terminado que aún no has mirado) suben arriba, en «Te necesitan». El resto sigue tus grupos: clic derecho en una sesión → Mover al grupo → Grupo nuevo…, o arrastra sesiones de un grupo a otro. Un clic en la cabecera de un grupo lo pliega (plegado sigue mostrando un punto por sesión), doble clic lo renombra y clic derecho permite reordenarlo o borrarlo. O bien, en Ajustes → Interfaz → Lista de sesiones → Por estado: te necesitan, trabajando, en reposo.
- **Buscador rápido** (`Ctrl+Shift+K`, o la lupa abajo en la barra lateral): escribe parte de un nombre, sus iniciales, un grupo o una carpeta, y pulsa Enter.
- **Avisos**: si la ventana no está en primer plano, recibes una notificación de Windows y parpadea la barra de tareas. El título de la ventana y la insignia muestran cuántas sesiones te necesitan. Al hacer clic en la notificación vas a la sesión.
- **Guardar y restaurar**: al cerrar se guardan las sesiones abiertas, su orden, la vista y la posición de la ventana. Al abrir, cada una se relanza con `claude --resume <id>`. El estado también se guarda continuamente, así que sobrevive a un cierre inesperado.
- **Sesiones interrumpidas**: si cierras mientras alguna trabaja, la app te avisa. Al volver, esa sesión muestra un aviso con el botón «Pedir que continúe».
- **Retomar conversaciones**: «Nueva» lista tus proyectos recientes (sacados de `~/.claude/projects`) y, para cada uno, sus conversaciones con título, último prompt y fecha. Marca las que ya están abiertas aquí o en otra terminal.
- **Mensajes entre sesiones**: el botón del sobre (`Ctrl+Shift+M`) abre un panel con lo que tus sesiones se dicen con `SendMessage`, con remitente → destinatario, el texto completo y si ya se ha leído. Los nombres de sesiones de la app llevan a ellas. Se registran los mensajes que salen de una sesión de la app y los que llegan a ella, aunque el otro extremo esté en otra terminal.
- **Sesiones fuera de la app**: abajo en la barra lateral aparecen las sesiones de Claude que tienes abiertas en otras terminales.
- **Plugins por sesión**: el botón de la pieza de puzle, arriba a la derecha, activa o desactiva un plugin solo en esa sesión, sin tocar tu configuración ni la del proyecto. De momento sirve para Playwright, que lanza su propio servidor en cada sesión donde está activo y conviene tenerlo apagado si no se usa. La propia sesión también puede pedirlo con la herramienta `set_plugin` (ver «Servidor MCP» más abajo). Aplicarlo exige reiniciar la sesión: si está trabajando, la app espera a que termine el turno. Mientras tanto se ve «↻ reinicio pendiente».
- **Reiniciar** (la flecha circular de arriba a la derecha): retoma la misma conversación, pero cierra el proceso, así que se pierden las tareas en segundo plano de la sesión (comandos, monitores, subagentes, recordatorios programados) y Remote Control se vuelve a conectar. La app lo avisa antes y puede dejarle una nota a la sesión al volver, para que te diga si tenía algo en marcha. Si el reinicio lo pidió la propia sesión, la nota le pide que relance lo que haga falta y continúe sola.
- **Vistas**: una sesión a pantalla completa, o todas en cuadrícula.
- **Ajustes** (`Ctrl+,` o el botón de los controles deslizantes, abajo en la barra lateral): el idioma (inglés, por defecto, o español), la tipografía y el tamaño de todas las terminales, y si se animan los indicadores de estado. La lista muestra las fuentes monoespaciadas instaladas, cada una escrita con su propia letra y con un buscador. Los cambios se ven al momento en todas las sesiones. Por defecto se usan la tipografía y el tamaño de Windows Terminal.

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+N` | Nueva sesión o retomar una conversación |
| `Ctrl+Shift+K` | Buscar una sesión por nombre, iniciales, grupo o carpeta |
| `Ctrl+Shift+J` | Ir a la siguiente sesión que te necesita (permiso > pregunta > terminada) |
| `Ctrl+1` … `Ctrl+9` | Ir a la sesión N (el número de su fila) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Sesión siguiente / anterior |
| `Ctrl+Shift+G` | Alternar entre una y cuadrícula |
| `Ctrl+Shift+M` | Panel de mensajes entre sesiones |
| `Ctrl+Shift+W` | Quitar la sesión actual (la conversación se conserva) |
| `Ctrl+C` / `Ctrl+V` | Copiar (si hay selección) / pegar. Sin texto en el portapapeles, `Ctrl+V` pasa a Claude para pegar imágenes |
| Clic derecho | Copiar la selección o pegar |
| `Shift+Enter` | Salto de línea en el prompt |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Tamaño de letra (`Ctrl+0`: el de Windows Terminal) |
| `Ctrl+,` | Ajustes: tipografía y tamaño |
| `F12` | DevTools |

Arriba a la derecha de cada sesión: plugins de la sesión (pieza de puzle), reiniciar (flecha circular) y quitar (✕).

Clic derecho en una sesión de la lista para su color, grupo, renombrar, reiniciar y quitar. Doble clic en el nombre para renombrar; si renombras desde Claude con `/rename`, la app también lo recoge. Arrastra en la lista para reordenar.

## Cómo funciona

- **Terminales**: Electron + [xterm.js](https://xtermjs.org/) con renderizado WebGL + [node-pty](https://github.com/microsoft/node-pty) (ConPTY). Mientras no elijas otra cosa en Ajustes, la tipografía y el tamaño se leen del perfil por defecto de Windows Terminal, así que las sesiones se ven igual que allí. La lista de fuentes sale de la API de acceso a fuentes locales de Chromium (`queryLocalFonts`), filtrada a las monoespaciadas. Se carga unos segundos después de arrancar, porque leerla tarda. La última línea de cada terminal queda siempre a 8 px del borde inferior.
- **Estado**: cada sesión se lanza con `--settings <archivo>`, que añade hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`). Cada hook hace `curl.exe` a un servidor HTTP local (`127.0.0.1`, puerto aleatorio y token) con el id de la terminal en la URL. **No se modifica tu `~/.claude/settings.json`**: los hooks solo existen en las sesiones que lanza la app.
- **IDs de sesión**: las conversaciones nuevas arrancan con `--session-id <uuid>` elegido por la app, así que siempre sabe qué retomar. Si haces `/clear`, el hook `SessionStart` le comunica el id nuevo.
- **Respaldo**: la app también vigila `~/.claude/sessions/<pid>.json`, el registro donde cada sesión de Claude publica si está `busy` o `idle` (y su nombre). Sirve para corregir el estado si se pierde un hook (por ejemplo, si rechazas un permiso), para seguir los `/rename` y para detectar sesiones abiertas fuera de la app. Es un formato interno de Claude Code, así que solo se usa como señal secundaria.
- **Mensajes**: del lado del remitente, el hook `PostToolUse` de `SendMessage` da el destinatario, el texto y la confirmación de entrega. Del lado del destinatario, el mensaje llega como un `UserPromptSubmit` envuelto en `<cross-session-message from-name="…">`. Cuando los dos extremos están en la app, ambas observaciones se unen en un solo registro que pasa de «en su bandeja» a «leído». Las respuestas suelen ir dirigidas al socket de la sesión (`uds:\\.\pipe\…`) y no a su nombre, así que la app las resuelve con el registro de sesiones. Los mensajes a subagentes dentro de una misma sesión no se registran.
- **Servidor MCP**: el mismo servidor local atiende un servidor MCP (HTTP, `/mcp/<id>`) que la app añade a cada sesión con `--mcp-config`. No arranca ningún proceso: es una ruta más del servidor de la app. Ofrece la herramienta `set_plugin`, con la que una sesión pide activar o desactivar un plugin solo para sí misma. La app guarda el cambio en el `--settings` de esa sesión (`enabledPlugins`, que tiene prioridad sobre tu configuración y la del proyecto). Cuando el turno termina, la relanza con `--resume` y le escribe una nota para que continúe. Para que no entre en bucle, una sesión puede pedir como mucho 6 reinicios por hora.
- **Datos guardados**: `%APPDATA%\cc-sessions\state.json` (sesiones con su color, grupo y plugins, los grupos, la vista), `settings.json` (Ajustes; un valor `null` significa «el predeterminado») y `messages.json` (los últimos 500 mensajes). Con la variable `CC_SESSIONS_USER_DATA` se puede usar otra carpeta, por ejemplo para pruebas. `CC_SESSIONS_CLAUDE=<ruta>` elige el ejecutable de `claude`. Con `CC_SESSIONS_HOOK_LOG=<archivo>` se vuelcan todos los eventos de hooks, como ayuda para depurar. Ese archivo guarda en texto plano tus prompts, los comandos y lo que devuelven las herramientas: no lo compartas.

## Limitaciones

- Restaurar retoma la **conversación**, no el trabajo a medias: lo que estaba ejecutando una sesión al cerrar se corta, y hay que pedirle que continúe. Tampoco sobreviven los procesos en segundo plano que hubiera lanzado (servidores de desarrollo, etc.).
- Abrir en la app una conversación que sigue viva en otra terminal crea dos procesos sobre la misma conversación. La app te avisa antes.
- Al contestar un permiso o una pregunta, el estado pasa a «Trabajando» al pulsar Enter, porque Claude no emite ningún hook en ese momento. Si contestaste «No», el registro lo corrige en unos segundos.
- Los mensajes entre dos sesiones que están ambas fuera de la app no se ven.
- Solo se ha probado en Windows 11.

## Licencia

[MIT](LICENSE).
