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

### El auxiliar de administrador

Las sesiones de administrador (ver abajo) pasan por un pequeño auxiliar que tiene que instalar un administrador, en una carpeta que solo pueden escribir los administradores: la app nunca eleva nada del repo, que tu usuario puede cambiar. Desde un PowerShell elevado, en el repo:

```powershell
powershell -NoProfile -File admin-host\install.ps1
```

Copia `admin-host.js`, node-pty y tu `node.exe` a `C:\Program Files\CC Sessions\admin-host` y comprueba allí cada fichero con `admin-host\manifest.json` (SHA-256), y `node.exe` por su firma (OpenJS Foundation). La primera vez escribe `admin-host.json`, la configuración del auxiliar, a partir de `admin-host.example.json`. En ella se pone:

- `claudeExe`: el `claude.exe` que ejecutan las sesiones, en una carpeta que solo pueden escribir los administradores (no el que actualizas con tu usuario). Tiene que estar firmado por Anthropic.
- `configDir`, `profileDir` y `tempDir`: dónde guardan esas sesiones la configuración de Claude, su carpeta personal (el `.bashrc` de Git Bash, el `.gitconfig` de git…) y sus temporales. Las tres, solo para administradores.
- `allowedRoots`: las carpetas en las que pueden trabajar esas sesiones, también solo para administradores.

Vuelve a ejecutarlo tras una actualización que cambie el auxiliar (`admin-host\manifest.json` cambia con él; la app avisa si el instalado es de otra versión). Para quitarlo, borra `C:\Program Files\CC Sessions`.

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
- **Lista organizada**: las sesiones que te necesitan (un permiso, una pregunta o un turno terminado que aún no has mirado) suben arriba, en «Te necesitan». Un turno que empezó una nota de la app o un mensaje de otra sesión («CC Sessions se ha reiniciado», por ejemplo) termina en silencio: sin puntito, sin notificación y sin subir, salvo que te pida algo. El resto sigue tus grupos: clic derecho en una sesión → Mover al grupo → Grupo nuevo…, o arrastra sesiones de un grupo a otro. Un clic en la cabecera de un grupo lo pliega (plegado sigue mostrando un punto por sesión), doble clic lo renombra y clic derecho permite reordenarlo o borrarlo. O bien, en Ajustes → Interfaz → Lista de sesiones → Por estado: te necesitan, trabajando, en reposo.
- **Decisiones**: una sesión que termina su turno con una línea `[proyecto] Necesito tu decisión: <pregunta>` te está pidiendo que decidas algo, igual que una que lo termina con un bloque «Pendiente de ti:» (la lista de lo que espera de ti, D1, D2…). Cada pregunta es una entrada: los puntos del bloque o, cuando la línea viene con preguntas numeradas (D1, D2…, como pide la norma si son varias), cada una de ellas. Aparece como «Necesita tu decisión», con la pregunta (o cuántas y cuáles), y sigue en «Te necesitan» hasta que contestes, aunque ya la hayas mirado y aunque reinicies la app. Lo que te pide hacer algo en vez de decidir (sin número, sin signo de interrogación y sin opciones, como «Ejecuta la orden de arriba y contesta "hecho"») sale como «Necesita que hagas algo», y su tarjeta lleva un botón «Hecho». Solo cuenta como respuesta un prompt tuyo: los mensajes de otras sesiones y las notas de la app no. Un prompt que nombra algunas («D5: sí», o un rango, «D4–D6: sí») contesta esas; uno que no nombra ninguna solo contesta las que no llevan número, que no se pueden nombrar, así que pedirle otra cosa a la sesión no hace desaparecer sus preguntas numeradas. Una pregunta nueva se suma a las que siguen abiertas; un bloque «Pendiente de ti» es la lista completa, así que lo que deja fuera se cierra, y «Pendiente de ti: nada» las cierra todas. Si lo pidió antes en el turno y siguió con otras cosas, como le dice la norma, o lo pidió cuando la app no estaba abierta, la app lo encuentra en la transcripción de la sesión, entre lo que ha dicho desde tu último mensaje; lo que hayas descartado no vuelve. La norma del `CLAUDE.md` global pide un bloque por decisión, numerado (`D1.` y la pregunta), con `Resumen:` (unas 50 palabras), `Opciones:` (separadas por `|`, con la recomendada marcada `(recomendada)`), `Si no contestas:` y `Contexto:` (unas 250 palabras de explicación en texto llano, no una copia de la conversación), como mucho tres por mensaje. La app lee esas partes para la bandeja; también valen las claves en inglés. La línea se encuentra en cualquier parte del mensaje, aunque lleve comillas invertidas, negritas o un `>` delante, pero no dentro de un bloque de código. (La convención está en el `CLAUDE.md` global: una sesión solo la sigue si se le pide.)
- **Ventanas de image-guard**: mientras la ventana de consentimiento de image-guard está abierta en una sesión, la sesión aparece como «Necesita tu consentimiento» y sube a «Te necesitan», aunque siga a mitad de su turno. La app solo lo muestra: siempre se contesta en la propia ventana de image-guard.
- **Esperando tu respuesta** (el botón de la bandeja junto a Nueva, el contador al lado del nombre o `Ctrl+Shift+I`): un panel con todas las sesiones que esperan algo de ti, de la más antigua a la más nueva: ventanas de image-guard, permisos, preguntas y decisiones. Cada tarjeta dice cuánto lleva esperando y qué pide, tal como lo escribió la sesión, y «Contexto» muestra tu último mensaje y su respuesta completa, para no tener que preguntarle de qué iba. Cada pregunta tiene su tarjeta: la pregunta, su resumen, qué hará la sesión si no contestas y un botón por opción (la recomendada destaca); un botón escribe «D1: Sí» en la sesión, como si lo hubieras hecho tú. «Contexto» muestra la explicación de la propia sesión o, en las decisiones pedidas a la antigua, tu último mensaje y su respuesta completa. Una decisión se puede contestar ahí mismo y solo se va esa tarjeta: si hay varias abiertas, la respuesta lleva delante su etiqueta o su tema («D6: no», «Bajas de scriptorium: …»), para que la sesión sepa a qué contesta. Se escribe en la sesión como prompt tuyo (Intro la envía, Mayús+Intro empieza otra línea), aunque esté trabajando: espera en su cola y la sesión la lee en su siguiente paso, como cuando escribes en su terminal. Los permisos y las preguntas se contestan en la sesión, porque escribir en ellos a ciegas podría elegir la opción equivocada, y las ventanas de image-guard solo en la propia ventana. Debajo, plegados, están los turnos que terminaron sin preguntar nada y que aún no has contestado. «Descartar» saca una de la lista sin contestar.
- **Aviso al móvil** (Ajustes): cuando haya sesiones que lleven esperando tu respuesta más de los minutos que pongas (una decisión, un permiso, una pregunta o una ventana de image-guard; los turnos terminados no) y no estés delante del PC (2 minutos sin teclado ni ratón, o bloqueado), la app ejecuta el comando que elijas con un aviso de una línea como último argumento, por ejemplo `ssh` a un equipo que lo reenvíe a un chat. El aviso dice cuántas sesiones esperan, cuáles y desde hace cuánto, nunca lo que preguntan. Como mucho uno cada 10 minutos, cada espera en un solo aviso, 30 s como máximo por ejecución y sin reintentos. El comando se ejecuta sin shell; las "comillas dobles" mantienen juntos los espacios y las `%VARIABLES%` se expanden. «Mandar una prueba» lo prueba al momento.
- **Buscador rápido** (`Ctrl+Shift+K`, o la lupa abajo en la barra lateral): escribe parte de un nombre, sus iniciales, un grupo o una carpeta, y pulsa Enter.
- **Avisos**: si la ventana no está en primer plano, recibes una notificación de Windows y parpadea la barra de tareas. El título de la ventana y la insignia muestran cuántas sesiones te necesitan. Al hacer clic en la notificación vas a la sesión.
- **Guardar y restaurar**: al cerrar se guardan las sesiones abiertas, su orden, la vista y la posición de la ventana. Al abrir, cada una se relanza con `claude --resume <id>`. El estado también se guarda continuamente, así que sobrevive a un cierre inesperado.
- **Sesiones interrumpidas**: si cierras mientras alguna trabaja, la app te avisa. Al volver, esa sesión muestra un aviso con el botón «Pedir que continúe».
- **Retomar conversaciones**: «Nueva» lista tus proyectos recientes (sacados de `~/.claude/projects`) y, para cada uno, sus conversaciones con título, último prompt y fecha. Marca las que ya están abiertas aquí o en otra terminal.
- **Mensajes entre sesiones**: el botón del sobre (`Ctrl+Shift+M`) abre un panel con lo que tus sesiones se dicen con `SendMessage`, con remitente → destinatario, el texto completo y si ya se ha leído. Los nombres de sesiones de la app llevan a ellas. Se registran los mensajes que salen de una sesión de la app y los que llegan a ella, aunque el otro extremo esté en otra terminal.
- **Sesiones fuera de la app**: abajo en la barra lateral aparecen las sesiones de Claude que tienes abiertas en otras terminales.
- **Plugins por sesión**: el botón de la pieza de puzle, arriba a la derecha, activa o desactiva un plugin solo en esa sesión, sin tocar tu configuración ni la del proyecto. De momento sirve para Playwright, que lanza su propio servidor en cada sesión donde está activo y conviene tenerlo apagado si no se usa. La propia sesión también puede pedirlo con la herramienta `set_plugin` (ver «Servidor MCP» más abajo). Aplicarlo exige reiniciar la sesión: si está trabajando, la app espera a que termine el turno. Mientras tanto se ve «↻ reinicio pendiente».
- **Reiniciar** (la flecha circular de arriba a la derecha): retoma la misma conversación, pero cierra el proceso, así que se pierden las tareas en segundo plano de la sesión (comandos, monitores, subagentes, recordatorios programados) y Remote Control se vuelve a conectar. La app lo avisa antes y puede dejarle una nota a la sesión al volver, para que te diga si tenía algo en marcha. Si el reinicio lo pidió la propia sesión, la nota le pide que relance lo que haga falta y continúe sola.
- **Sesiones de administrador**: clic derecho en una sesión → Ejecutar como administrador. Se reinicia en la misma conversación tras aceptar el aviso de Windows, y a partir de ahí es una sesión como las demás, marcada con un escudo. El aviso sale una vez por cada vez que abres la app: los reinicios y las demás sesiones de administrador reutilizan el permiso. Al reabrir la app, las sesiones de administrador esperan a que pulses «Iniciar como administrador», así que el aviso nunca aparece solo. **Ten en cuenta el coste**: como administrador, lo que ejecute la sesión tiene control total del equipo, y CC Sessions, que no tiene esos permisos, puede escribir en ella, así que un programa que se ejecute con tu usuario podría usar la app para actuar como administrador. Por eso Windows Terminal no mezcla pestañas de administrador y normales en una misma ventana. Solo funciona con tu propia cuenta: si el aviso se acepta con otra, la sesión no arranca. Antes hay que instalar el auxiliar de administrador (ver «El auxiliar de administrador» arriba). Justo antes del aviso de Windows la app dice que va a salir, y para qué sesión: el aviso pone «Procesador de comandos de Windows», así que uno que salga sin ese mensaje es una señal de alarma. Como administrador, la sesión tiene su propia configuración de Claude, carpeta personal y temporales, que solo pueden escribir los administradores, y no carga los ajustes ni los servidores MCP de tu proyecto.
- **Reiniciar la app** (el botón de apagado, abajo en la barra lateral): al reiniciar se cierra el proceso de cada sesión, y con él sus tareas en segundo plano. Así que antes se puede pedir a todas las sesiones abiertas que las paren (comandos, monitores, recordatorios programados, subagentes), que no empiecen otras hasta nuevo aviso y que dejen lo que tengan a medias en un punto desde el que retomarlo. A las sesiones ociosas se les escribe la petición; las que están trabajando la leen con el resultado de su siguiente paso (su hook `PostToolUse`), así que no se les escribe nada encima; a una que espera tu permiso o tu respuesta no se la toca hasta que hayas contestado. El panel muestra cómo va cada una y qué ha contestado. Después reinicias, o simplemente cierras la app; al volver, a cada una se le dice que relance lo que paró y continúe (con una casilla se desactiva, y esperan a que se lo digas tú). Cancelar el reinicio les dice que pueden seguir.
- **Vistas**: una sesión a pantalla completa, o todas en cuadrícula.
- **Ajustes** (`Ctrl+,` o el botón de los controles deslizantes, abajo en la barra lateral): el idioma (inglés, por defecto, o español), la tipografía y el tamaño de todas las terminales, y si se animan los indicadores de estado. La lista muestra las fuentes monoespaciadas instaladas, cada una escrita con su propia letra y con un buscador. Los cambios se ven al momento en todas las sesiones. Por defecto se usan la tipografía y el tamaño de Windows Terminal.

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+N` | Nueva sesión o retomar una conversación |
| `Ctrl+Shift+K` | Buscar una sesión por nombre, iniciales, grupo o carpeta |
| `Ctrl+Shift+J` | Ir a la siguiente sesión que te necesita (permiso > pregunta > terminada) |
| `Ctrl+1` … `Ctrl+9` | Ir a la sesión N (mantén Ctrl un momento para ver los números en la lista) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Sesión siguiente / anterior |
| `Ctrl+Shift+G` | Alternar entre una y cuadrícula |
| `Ctrl+Shift+I` | Esperando tu respuesta: decisiones, permisos, preguntas |
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
- **Vista de agentes apagada**: el mismo archivo pone `disableAgentView`. Con la vista de agentes, ← con el prompt vacío manda la conversación a segundo plano, al supervisor del propio Claude, fuera del panel y de la app. `claude agents` en una terminal tuya sigue funcionando.
- **IDs de sesión**: las conversaciones nuevas arrancan con `--session-id <uuid>` elegido por la app, así que siempre sabe qué retomar. Si haces `/clear`, el hook `SessionStart` le comunica el id nuevo.
- **Respaldo**: la app también vigila `~/.claude/sessions/<pid>.json`, el registro donde cada sesión de Claude publica si está `busy` o `idle` (y su nombre). Sirve para corregir el estado si se pierde un hook (por ejemplo, si rechazas un permiso), para seguir los `/rename` y para detectar sesiones abiertas fuera de la app. Es un formato interno de Claude Code, así que solo se usa como señal secundaria.
- **Mensajes**: del lado del remitente, el hook `PostToolUse` de `SendMessage` da el destinatario, el texto y la confirmación de entrega. Del lado del destinatario, el mensaje llega como un `UserPromptSubmit` envuelto en `<cross-session-message from-name="…">`. Cuando los dos extremos están en la app, ambas observaciones se unen en un solo registro que pasa de «en su bandeja» a «leído». Las respuestas suelen ir dirigidas al socket de la sesión (`uds:\\.\pipe\…`) y no a su nombre, así que la app las resuelve con el registro de sesiones. Los mensajes a subagentes dentro de una misma sesión no se registran.
- **Avisos de image-guard**: cada sesión que arranca la app recibe en su entorno, que heredan sus hooks, `CC_SESSIONS_GUARD_URL` (`http://127.0.0.1:<puerto>/guard/<terminalId>`) y `CC_SESSIONS_GUARD_TOKEN`. El hook de image-guard manda ahí `{"event":"open"}` y `{"event":"close"}`, con el token en `X-CC-Sessions-Token` y, si quiere, `until` (cuándo da la ventana por cerrada, en ms), y la app contesta 204 al momento. Las ventanas se cuentan, porque puede haber varias abiertas a la vez, y un cierre sin su apertura se ignora. Cada una se descarta al llegar su `until` o, como muy tarde, a los 3700 s (cuando Claude Code mata un hook), por si el cierre no llega. El token solo deja pasar estos avisos, pero está en el entorno, así que cualquier cosa que ejecute una sesión puede leerlo: como mucho podría poner en la lista una entrada inventada.
- **Servidor MCP**: el mismo servidor local atiende un servidor MCP (HTTP, `/mcp/<id>`) que la app añade a cada sesión con `--mcp-config`. No arranca ningún proceso: es una ruta más del servidor de la app. Ofrece la herramienta `set_plugin`, con la que una sesión pide activar o desactivar un plugin solo para sí misma. La app guarda el cambio en el `--settings` de esa sesión (`enabledPlugins`, que tiene prioridad sobre tu configuración y la del proyecto). Cuando el turno termina, la relanza con `--resume` y le escribe una nota para que continúe. Para que no entre en bucle, una sesión puede pedir como mucho 6 reinicios por hora.
- **Sesiones de administrador**: Windows solo arranca un proceso de administrador tras su propio aviso, y nunca como un proceso hijo al que la app pueda conectar una terminal. Así que la primera sesión de administrador arranca el auxiliar instalado en `C:\Program Files\CC Sessions\admin-host` con `Start-Process -Verb RunAs`, a través de `cmd /d` (que se salta el AutoRun de cmd) tras vaciar todas las variables que Node lee al arrancar: un proceso elevado toma su entorno del registro, `HKCU\Environment` incluido, que tu usuario puede escribir, y un `NODE_OPTIONS=--require …` ahí ejecutaría código como administrador. El auxiliar se conecta de vuelta a la app en `127.0.0.1` con un token de un solo uso y ejecuta esas sesiones en sus propias ConPTY, reenviando su salida y lo que escribes. No se fía de nada más que venga de la app: la app solo dice qué sesión (ids, nombre, carpeta, tamaño y cómo llegan sus hooks a la app), y el resto lo decide el auxiliar. Solo ejecuta `claudeExe`, tras comprobar su firma Authenticode, con una línea de órdenes fija (`--resume` o `--session-id`, `--name`, `--settings` con un fichero que escribe él con los hooks de estado de la app, `--setting-sources user` y `--strict-mcp-config`, para que no se carguen los ajustes ni los servidores MCP de tu proyecto) y un entorno propio (`PATH` fijo; `PSModulePath` con los módulos del sistema primero y tu `Documents\PowerShell\Modules` al final, donde PowerShell 7 no puede ponerlo delante; carpeta personal, AppData y `TEMP` en sus carpetas solo de administradores; `CLAUDE_CONFIG_DIR`; `DISABLE_UPDATES=1`). La carpeta de trabajo tiene que estar dentro de `allowedRoots`, y ella, lo que Claude lee en ella (`.claude`, `.mcp.json`, `CLAUDE.md`, `.git`) y esas carpetas, además de cada carpeta de su `path`, solo las pueden escribir SYSTEM y Administradores, y ninguna puede ser un enlace (punto de reanálisis); `.git` tiene que ser una carpeta. Las carpetas por encima de todas ellas no pueden dejar a nadie más borrar, renombrar o adueñarse de lo que hay dentro. Y como Claude también carga `CLAUDE.md`, `CLAUDE.local.md` y `.claude` de todas las carpetas por encima de la de trabajo, nadie más puede poder crearlos ahí: `C:\ProgramData` deja a cualquiera crear ficheros, así que necesita un marcador vacío, solo de administradores, de cada uno. Los hooks de la app solo informan: su respuesta va a `NUL`, así que la app, que no está elevada, no puede aprobar una herramienta ni colar contexto sin que se vea. Lo que la sesión oye al arrancar sale de un fichero que escribe el auxiliar. La línea que arranca el auxiliar también deja `PATH` en el del sistema, para que node.exe no cargue DLL de tus carpetas. Todo lo demás se rechaza y se anota en `logs\admin-host.log`, a su lado. Cuando la app se cierra (o se cae) la conexión se corta, y el auxiliar cierra sus sesiones y sale. A la propia sesión se le dice que es de administrador: la app contesta a su hook `SessionStart` con eso como `additionalContext`, así que lo vuelve a oír en cada reanudación, `/clear` y compactación. (`--append-system-prompt` no serviría: Claude reutiliza el primer system prompt de una conversación al reanudarla.) Al desactivarlo, el siguiente arranque le dice que ya no tiene esos permisos. Para pruebas, `CC_SESSIONS_ADMIN_NO_ELEVATE` arranca el auxiliar sin el aviso (y por tanto sin permisos), y solo entonces `CC_SESSIONS_ADMIN_HOST_DIR` puede apuntar a otra copia.
- **Datos guardados**: `%APPDATA%\cc-sessions\state.json` (sesiones con su color, grupo y plugins, los grupos, la vista), `settings.json` (Ajustes; un valor `null` significa «el predeterminado») y `messages.json` (los últimos 500 mensajes). Con la variable `CC_SESSIONS_USER_DATA` se puede usar otra carpeta, por ejemplo para pruebas. `CC_SESSIONS_CLAUDE=<ruta>` elige el ejecutable de `claude`. `CC_SESSIONS_ADMIN_NO_ELEVATE=1` ejecuta las sesiones de administrador a través del auxiliar pero sin el aviso (y por tanto sin permisos de administrador), para pruebas. Con `CC_SESSIONS_HOOK_LOG=<archivo>` se vuelcan todos los eventos de hooks, como ayuda para depurar. Ese archivo guarda en texto plano tus prompts, los comandos y lo que devuelven las herramientas: no lo compartas.

## Limitaciones

- Restaurar retoma la **conversación**, no el trabajo a medias: lo que estaba ejecutando una sesión al cerrar se corta, y hay que pedirle que continúe. Tampoco sobreviven los procesos en segundo plano que hubiera lanzado (servidores de desarrollo, etc.).
- Abrir en la app una conversación que sigue viva en otra terminal crea dos procesos sobre la misma conversación. La app te avisa antes.
- Al contestar un permiso o una pregunta, el estado pasa a «Trabajando» al pulsar Enter, porque Claude no emite ningún hook en ese momento. Si contestaste «No», el registro lo corrige en unos segundos.
- Los mensajes entre dos sesiones que están ambas fuera de la app no se ven.
- Las sesiones normales no pueden conectarse al canal de mensajes de una sesión de administrador (Windows lo impide), así que sus mensajes solo le llegan a través de Remote Control, si lo tiene activado. Los suyos a ellas llegan con normalidad.
- Solo se ha probado en Windows 11.

## Licencia

[MIT](LICENSE).
