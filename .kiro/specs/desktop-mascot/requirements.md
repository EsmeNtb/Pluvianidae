# Requirements Document

## Introduction

Este documento formaliza los requisitos para convertir la mascota de Pluvianidae en una **aplicación de escritorio Electron independiente**, flotante y siempre visible por encima de VS Code y de otras aplicaciones, reemplazando su implementación actual como panel dentro de una webview del editor. Los requisitos se derivan de `design.md` (workflow Design-First) y cubren: la ventana Electron, la separación en tres componentes (extensión / app Electron / contratos compartidos), el protocolo de comunicación local, el contrato de eventos, los estados visuales, la interacción del usuario, la integración con la extensión existente, la seguridad, los scripts npm, la compatibilidad con la funcionalidad ya existente, y las pruebas necesarias.

## Glossary

- **Sistema**: La extensión Pluvianidae junto con la aplicación de escritorio de la mascota, consideradas en conjunto.
- **Extensión**: El proceso de la extensión de VS Code (`src/`), ya existente.
- **App_Electron**: El proceso de escritorio independiente construido con Electron (`desktop-mascot/`), nuevo en este feature.
- **Mascota_De_Escritorio**: La ventana flotante de `App_Electron` que representa visualmente a la mascota.
- **DesktopMascotManager**: La clase de la Extensión (`src/services/desktop-mascot-manager.ts`) que controla el ciclo de vida de `App_Electron`.
- **Servidor_Local**: El servidor HTTP (`http.Server` nativo de Node) que corre dentro de la Extensión, escuchando exclusivamente en `127.0.0.1`, usado para intercambiar eventos con `App_Electron`.
- **MascotEvent**: El tipo de mensaje definido en `shared/mascot-events.ts`, enviado de la Extensión hacia `App_Electron`.
- **MascotAction**: El tipo de mensaje definido en `shared/mascot-actions.ts`, enviado de `App_Electron` hacia la Extensión (originado en el menú contextual).
- **Usuario**: Persona desarrolladora que interactúa con VS Code, Pluvianidae y la Mascota_De_Escritorio.
- **Módulos_Existentes**: Los módulos ya implementados de Pluvianidae que no deben romperse: indexer, searcher, reference-analyzer, dead-code-detector, frontend-backend-comparator, pre-commit-reviewer (incluye secret-detector), readme-generator, explainer.

## Requirements

### Requirement 1: Ventana de la Mascota_De_Escritorio

**User Story:** Como desarrollador, quiero que la mascota aparezca en una ventana flotante siempre visible sobre cualquier otra aplicación, para poder ver sus mensajes sin que quede oculta detrás del editor o de otras ventanas.

#### Acceptance Criteria

1. THE App_Electron SHALL crear la ventana de la Mascota_De_Escritorio con la propiedad `alwaysOnTop` activada, de forma que permanezca por encima de VS Code, de otros IDEs, de navegadores y de cualquier otra aplicación.
2. THE App_Electron SHALL crear la ventana de la Mascota_De_Escritorio con fondo transparente (`transparent: true`).
3. THE App_Electron SHALL crear la ventana de la Mascota_De_Escritorio sin bordes ni barra de título (`frame: false`).
4. THE App_Electron SHALL crear la ventana de la Mascota_De_Escritorio sin que aparezca en la barra de tareas del sistema operativo (`skipTaskbar: true`).
5. THE App_Electron SHALL crear la ventana de la Mascota_De_Escritorio como no redimensionable, no maximizable, no minimizable y sin sombra (`resizable: false`, `maximizable: false`, `minimizable: false`, `hasShadow: false`).
6. THE App_Electron SHALL crear la ventana de la Mascota_De_Escritorio con un tamaño aproximado de 260x240 píxeles.
7. THE App_Electron SHALL configurar `webPreferences` de la ventana con una ruta de `preload` válida, `contextIsolation: true` y `nodeIntegration: false`.
8. WHEN la Mascota_De_Escritorio se muestra por primera vez sin una posición guardada previamente, THE App_Electron SHALL calcular su posición inicial cerca de la esquina inferior derecha del display primario usando `screen.getPrimaryDisplay().workArea`.
9. WHEN la Mascota_De_Escritorio se inicia y existe una posición previamente guardada que cae dentro del área de trabajo de al menos uno de los displays conectados, THE App_Electron SHALL restaurar esa posición guardada en lugar de la posición por defecto; IF la posición guardada no cae dentro de ningún display conectado, THEN THE App_Electron SHALL usar la posición por defecto de la esquina inferior derecha.
10. WHEN el Usuario arrastra la Mascota_De_Escritorio con el mouse, THE App_Electron SHALL mover la ventana siguiendo el cursor y SHALL guardar la nueva posición de forma persistente para restaurarla en la siguiente sesión.

### Requirement 2: Arquitectura y separación de componentes

**User Story:** Como desarrollador del proyecto, quiero que la mascota de escritorio esté claramente separada de la extensión VS Code y de sus contratos de comunicación, para poder mantener y compilar cada pieza de forma independiente sin romper la otra.

#### Acceptance Criteria

1. THE Sistema SHALL estructurarse en tres componentes con límites de dependencia explícitos: la Extensión (`src/`), la App_Electron (`desktop-mascot/`) y los contratos compartidos (`shared/`).
2. THE Extensión SHALL NOT importar directamente ningún módulo del paquete `electron` ni ningún archivo dentro de `desktop-mascot/`.
3. THE App_Electron SHALL NOT importar directamente ningún archivo dentro de `src/` de la Extensión.
4. THE Extensión y THE App_Electron SHALL importar los tipos de mensajes exclusivamente desde `shared/`, sin duplicar la definición de `MascotEvent` ni de `MascotAction` en ningún otro archivo; THE Sistema SHALL requerir que al menos uno de los dos componentes importe efectivamente desde `shared/` cuando necesite usar `MascotEvent` o `MascotAction`.
5. THE App_Electron SHALL definirse como un paquete npm independiente, con su propio `package.json` y `tsconfig.json`, compilable sin requerir que la Extensión esté compilada.

### Requirement 3: Protocolo de comunicación local

**User Story:** Como desarrollador, quiero que la extensión y la mascota de escritorio se comuniquen de forma local, segura y resiliente a caídas de conexión, para que los mensajes lleguen de forma confiable sin exponer ningún servicio fuera de la máquina del usuario.

#### Acceptance Criteria

1. THE Servidor_Local SHALL escuchar exclusivamente en la dirección `127.0.0.1`, y SHALL NOT escuchar en `0.0.0.0` ni en ninguna interfaz de red distinta de loopback.
2. WHILE la App_Electron mantiene una conexión activa con el Servidor_Local, THE Sistema SHALL entregar cada MascotEvent enviado por `DesktopMascotManager.send(...)` exactamente una vez y en el mismo orden en que fue emitido.
3. WHEN la conexión entre App_Electron y el Servidor_Local se interrumpe, THE App_Electron SHALL reintentar la reconexión automáticamente usando un backoff exponencial acotado entre un valor mínimo y un valor máximo configurados, sin detener permanentemente el ciclo de reintentos.
4. THE Servidor_Local y THE App_Electron SHALL validar de forma estricta todo mensaje recibido contra la forma exacta de `MascotEvent` o `MascotAction` (según la dirección del mensaje) antes de usarlo, mediante funciones de verificación de tipo (type guards).
5. IF un mensaje recibido por el Servidor_Local o por la App_Electron no pasa la validación de tipo, THEN THE Sistema SHALL descartar el mensaje, registrar el evento en el log correspondiente, y SHALL NOT cerrar la conexión ni ejecutar ningún código contenido en el mensaje.
6. THE Servidor_Local SHALL usar un puerto configurable mediante ajuste de la Extensión; IF el puerto preferido no está disponible, THEN THE Servidor_Local SHALL autodetectar un puerto libre sin requerir intervención del Usuario.
7. THE DesktopMascotManager SHALL garantizar que exista como máximo un Servidor_Local activo por instancia de la Extensión, y THE App_Electron SHALL garantizar que exista como máximo un proceso de App_Electron activo por máquina mediante un mecanismo de bloqueo de instancia única; IF el mecanismo de bloqueo de instancia única falla por una causa ajena a este feature (p. ej. una falla del propio sistema operativo), THEN THE Sistema SHALL permitir que los procesos duplicados coexistan en vez de intentar detectarlos y terminarlos activamente.

### Requirement 4: Contrato de eventos y acciones compartido

**User Story:** Como desarrollador del proyecto, quiero que exista una única fuente de verdad para la forma de los mensajes intercambiados entre la extensión y la mascota, para evitar que ambos lados diverjan silenciosamente sobre el formato de los datos.

#### Acceptance Criteria

1. THE Sistema SHALL definir el tipo `MascotEvent` en `shared/mascot-events.ts` con exactamente las variantes: `idle`, `indexing` (con `file` y `progress` opcionales), `success` (con `message`), `warning` (con `message`), `error` (con `message`), `seed` (con `amount`), `hide` y `show`.
2. THE Sistema SHALL definir el tipo `MascotAction` en `shared/mascot-actions.ts` con exactamente las variantes: `analyze-repository`, `precommit-review`, `show-seed-basket`, `mute-messages`, `hide-mascot` y `close-mascot`, sin parámetros de texto libre.
3. THE Sistema SHALL rechazar, mediante el type guard correspondiente, cualquier objeto `MascotEvent` o `MascotAction` que contenga campos adicionales a los definidos para su variante, o que tenga un discriminante (`type`/`action`) fuera de las variantes definidas.
4. THE Extensión SHALL validar cada `MascotEvent` con `isMascotEvent` antes de serializarlo y enviarlo, de forma que ningún mensaje malformado salga de la Extensión.

### Requirement 5: Estados visuales y animaciones de la Mascota_De_Escritorio

**User Story:** Como desarrollador, quiero que la mascota muestre visualmente su estado actual (esperando, pensando, trabajando, éxito, advertencia, error o dormida), para entender de un vistazo qué está pasando sin leer texto.

#### Acceptance Criteria

1. THE App_Electron SHALL soportar los siete estados visuales: idle, thinking, working, success, warning, error y sleeping.
2. WHEN la App_Electron recibe un MascotEvent de tipo `idle`, THE App_Electron SHALL mostrar la animación de respiración suave correspondiente al estado idle; IF la App_Electron recibe un MascotEvent cuyo `type` no coincide con ninguna de las variantes mapeadas a una animación, THEN THE App_Electron SHALL mostrar la animación por defecto del estado idle.
3. WHEN la App_Electron recibe un MascotEvent de tipo `indexing`, THE App_Electron SHALL mostrar la animación de saltos pequeños correspondiente al estado working.
4. WHEN la App_Electron recibe un MascotEvent de tipo `success`, THE App_Electron SHALL mostrar la animación de semillas cayendo correspondiente al estado success.
5. WHEN la App_Electron recibe un MascotEvent de tipo `warning`, THE App_Electron SHALL mostrar la animación de vibración correspondiente al estado warning.
6. WHEN la App_Electron recibe un MascotEvent de tipo `error`, THE App_Electron SHALL mostrar la animación de sobresalto correspondiente al estado error.
7. WHEN la App_Electron recibe un MascotEvent de tipo `hide`, THE App_Electron SHALL mostrar una opacidad reducida correspondiente al estado sleeping antes de completar la ocultación.
8. THE App_Electron SHALL implementar los estados visuales de la v1 usando emoji o el asset ya existente de la mascota, sin requerir la creación de arte nuevo.

### Requirement 6: Burbujas de mensaje

**User Story:** Como desarrollador, quiero ver mensajes breves junto a la mascota sin que ocupen mucho espacio en pantalla, para enterarme de lo que ocurre sin que la mascota se vuelva intrusiva.

#### Acceptance Criteria

1. WHEN la App_Electron recibe un MascotEvent con un campo `message` o `file`, THE App_Electron SHALL mostrar una burbuja pequeña junto a la mascota con el texto correspondiente.
2. THE App_Electron SHALL truncar visualmente el texto de la burbuja cuando exceda el ancho disponible, y SHALL mostrar el mensaje completo mediante un tooltip (atributo `title`) sobre la burbuja.
3. THE App_Electron SHALL insertar el texto de cualquier burbuja proveniente de un MascotEvent usando exclusivamente `textContent`; IF el texto de un mensaje no se inserta mediante `textContent`, THEN THE Sistema SHALL considerar esto un fallo. THE App_Electron SHALL NOT usar `innerHTML` para insertar contenido proveniente de un MascotEvent, aunque SHALL poder seguir usando `innerHTML` para elementos estáticos de confianza de la interfaz (por ejemplo bordes o iconos de la burbuja) que no contengan texto proveniente de un MascotEvent.
4. THE App_Electron SHALL ocultar automáticamente cada burbuja después de un tiempo fijo sin intervención del Usuario.
5. THE App_Electron SHALL NOT mostrar un panel oscuro grande para las burbujas de mensaje.

### Requirement 7: Interacción del Usuario con la Mascota_De_Escritorio

**User Story:** Como desarrollador, quiero poder mover la mascota por la pantalla y acceder a un conjunto limitado de acciones mediante un menú contextual, para controlar la mascota sin salir del flujo de trabajo.

#### Acceptance Criteria

1. THE App_Electron SHALL permitir arrastrar la Mascota_De_Escritorio a cualquier posición de la pantalla mediante el mouse.
2. WHEN el Usuario abre el menú contextual de la Mascota_De_Escritorio, THE App_Electron SHALL mostrar exclusivamente las siguientes opciones: "Analizar repositorio", "Revisión pre-commit", "Mostrar cesto de semillas", "Silenciar mensajes", "Ocultar mascota" y "Cerrar mascota", y SHALL rechazar cualquier acción que no corresponda a una de estas seis opciones.
3. WHEN el Usuario selecciona una opción del menú contextual, THE App_Electron SHALL enviar el `MascotAction` correspondiente a la Extensión mediante el Servidor_Local.
4. WHEN el Usuario selecciona "Ocultar mascota", THE Sistema SHALL ocultar la ventana de la Mascota_De_Escritorio sin finalizar el proceso de App_Electron; THE Sistema SHALL también poder ocultar automáticamente la Mascota_De_Escritorio sin acción explícita del Usuario cuando sea necesario por razones operativas del propio Sistema (por ejemplo, apagado del sistema operativo o condiciones de bajos recursos).
5. WHEN el Usuario selecciona "Cerrar mascota", THE Sistema SHALL finalizar completamente el ciclo de vida de la Mascota_De_Escritorio, incluyendo el proceso de App_Electron.

### Requirement 8: Integración de la Extensión con la Mascota_De_Escritorio

**User Story:** Como desarrollador, quiero que la extensión notifique a la mascota de escritorio sobre los eventos relevantes del análisis del repositorio, para que la mascota refleje en tiempo real lo que está haciendo Pluvianidae, sin que un fallo de la mascota afecte el resto de la extensión.

#### Acceptance Criteria

1. THE Extensión SHALL exponer una clase `DesktopMascotManager` con los métodos `start()`, `stop()`, `show()`, `hide()`, `send(event)` y `dispose()`, todos retornando `Promise<void>`.
2. WHEN la Extensión invoca `DesktopMascotManager.send(event)` para una secuencia de eventos internos (inicio de indexación, fin de indexación, hallazgo de código no utilizado, hallazgo frontend-backend, detección de secretos, fin de revisión pre-commit, error, finalización de una acción, generación de semillas), THE DesktopMascotManager SHALL preservar el orden de emisión de esos eventos al entregarlos a la Mascota_De_Escritorio.
3. IF `App_Electron` no está disponible o falla al iniciar (binario no encontrado, error de proceso, timeout de arranque), THEN THE DesktopMascotManager SHALL resolver sus métodos sin lanzar excepciones, SHALL registrar el fallo en el log de la Extensión, y THE Extensión SHALL continuar funcionando con normalidad; THE Extensión SHALL además ocultar o deshabilitar los elementos de interfaz relacionados con la mascota mientras App_Electron no esté disponible, y THE DesktopMascotManager SHALL reintentar periódicamente la conexión con App_Electron a lo largo de la sesión en lugar de deshabilitar la funcionalidad de forma permanente.
4. THE Extensión SHALL respetar el ajuste de configuración `pluvianidae.enableMascot`; IF dicho ajuste es `false`, THEN THE Extensión SHALL NOT construir ni iniciar ningún proceso de App_Electron.
5. WHEN `DesktopMascotManager.dispose()` es invocado, THE DesktopMascotManager SHALL liberar todos los listeners del Event Bus registrados para la mascota de escritorio.

### Requirement 9: Seguridad

**User Story:** Como desarrollador responsable del proyecto, quiero que la comunicación entre la extensión y la mascota de escritorio, y la ventana de Electron en sí, sigan prácticas de seguridad estrictas, para evitar ejecución de código no confiable o filtraciones de datos.

#### Acceptance Criteria

1. THE App_Electron SHALL configurar cada `BrowserWindow` con `nodeIntegration: false` y `contextIsolation: true`, y SHALL exponer únicamente una API mínima al proceso de renderizado mediante `contextBridge`.
2. THE App_Electron SHALL validar todo mensaje IPC recibido entre `preload` y `main`, y entre `main` y `renderer`, antes de actuar sobre su contenido.
3. THE Servidor_Local SHALL aceptar conexiones únicamente desde `127.0.0.1`.
4. WHEN la Mascota_De_Escritorio se cierra o se dispone (`dispose()`), THE Sistema SHALL garantizar la limpieza de todos los sockets abiertos, listeners registrados, temporizadores activos y procesos hijos asociados, mediante un enfoque de mejor esfuerzo: IF alguna operación de limpieza individual falla, THEN THE Sistema SHALL continuar intentando limpiar el resto de los recursos en lugar de abortar el proceso de disposición completo; THE Sistema SHALL permitir estados intermedios de limpieza parcial (por ejemplo, algunos recursos ya liberados mientras otros aún se están cerrando) siempre que todos los recursos terminen liberándose eventualmente.
5. THE App_Electron SHALL construir el menú contextual únicamente a partir de la lista cerrada de acciones definida en `MascotAction`, y THE Sistema SHALL NOT ejecutar ninguna acción o comando que no pertenezca a esa lista.
6. THE Sistema SHALL construir toda ruta de archivo usando `path.join`, y SHALL NOT construir rutas mediante concatenación manual de cadenas de texto.
7. THE Sistema SHALL documentar explícitamente que el Servidor_Local no implementa autenticación entre la Extensión y la App_Electron, y que esto se considera aceptable dado que ambos procesos corren localmente bajo el mismo usuario del sistema operativo.

### Requirement 10: Scripts npm

**User Story:** Como desarrollador del proyecto, quiero contar con scripts npm claros para instalar, compilar y ejecutar la mascota de escritorio junto con la extensión, para poder desarrollar ambas piezas de forma predecible.

#### Acceptance Criteria

1. THE Sistema SHALL definir un script `mascot:install` que instale las dependencias del paquete `desktop-mascot/` de forma independiente de las dependencias de la Extensión.
2. THE Sistema SHALL definir un script `mascot:dev` que ejecute únicamente la App_Electron en modo desarrollo.
3. THE Sistema SHALL definir un script `mascot:build` que compile la App_Electron para su uso por `DesktopMascotManager`.
4. THE Sistema SHALL definir un script `dev` que ejecute la Extensión y la App_Electron simultáneamente en modo desarrollo.
5. THE Sistema SHALL mantener el script `compile` existente, compilando únicamente la Extensión VS Code hacia `out/src/extension.js`, sin incluir la compilación de `desktop-mascot/`.
6. THE Sistema SHALL mantener el script `test` existente, ejecutando la suite de pruebas completa, incluyendo las pruebas nuevas de este feature.

### Requirement 11: Compatibilidad con la funcionalidad existente

**User Story:** Como desarrollador del proyecto, quiero que la introducción de la mascota de escritorio no rompa ningún módulo ya implementado de Pluvianidae, para no regresar funcionalidad ya entregada.

#### Acceptance Criteria

1. THE Sistema SHALL mantener el comportamiento observable de todos los Módulos_Existentes sin modificaciones funcionales derivadas de este feature.
2. THE Extensión SHALL NOT eliminar el archivo `src/presentation/mascot/mascot-webview.ts` ni las clases que contiene como parte de este feature.
3. THE Extensión SHALL dejar de invocar `mascot-webview.ts` como mascota principal en `extension.ts`, sustituyéndola por `DesktopMascotManager`, sin eliminar su código ni sus pruebas existentes.
4. THE Sistema SHALL documentar en `design.md` la decisión sobre el uso futuro de `mascot-webview.ts` (reutilización como panel secundario o desuso) junto con su justificación.

### Requirement 12: Pruebas y verificación

**User Story:** Como desarrollador del proyecto, quiero que cada aspecto crítico de la mascota de escritorio esté cubierto por pruebas automatizadas, para detectar regresiones antes de que lleguen a producción.

#### Acceptance Criteria

1. THE Sistema SHALL incluir pruebas que verifiquen la validación de esquema de `MascotEvent` y `MascotAction` contra entradas válidas e inválidas.
2. THE Sistema SHALL incluir pruebas que verifiquen que la serialización seguida de la deserialización de un `MascotEvent` o `MascotAction` válido produce un valor estructuralmente equivalente al original.
3. THE Sistema SHALL incluir pruebas que verifiquen que un mensaje inválido recibido por el Servidor_Local o por la App_Electron es rechazado de forma segura sin cerrar la conexión.
4. THE Sistema SHALL incluir pruebas que verifiquen la reconexión automática de la App_Electron tras una caída simulada de la conexión con el Servidor_Local.
5. THE Sistema SHALL incluir pruebas que verifiquen que un segundo intento de iniciar la App_Electron, mientras una instancia ya está en ejecución, no crea una segunda ventana visible.
6. THE Sistema SHALL incluir pruebas que verifiquen el inicio y apagado correcto de `DesktopMascotManager`, cubriendo su máquina de estados completa.
7. THE Sistema SHALL incluir pruebas que verifiquen que, tras invocar `DesktopMascotManager.dispose()`, no queda ningún proceso de App_Electron en ejecución.
8. THE Sistema SHALL incluir pruebas que verifiquen que un fallo al iniciar Electron no impide que `DesktopMascotManager.start()` resuelva sin lanzar excepciones.
9. THE Sistema SHALL incluir pruebas que verifiquen que la posición de la ventana persistida se restaura correctamente entre sesiones, incluyendo el caso de una posición guardada fuera de todos los displays conectados.
10. THE Sistema SHALL incluir pruebas que verifiquen que los comandos del menú contextual dentro de la allowlist son aceptados y que cualquier valor fuera de la allowlist es rechazado.

### Requirement 13: Criterios de aceptación generales de la etapa

**User Story:** Como desarrollador del proyecto, quiero un conjunto de criterios de aceptación de alto nivel que confirmen que la mascota de escritorio funciona de punta a punta, para saber cuándo el feature está listo para revisión.

#### Acceptance Criteria

1. THE Extensión SHALL compilar correctamente mediante el script `compile`.
2. THE App_Electron SHALL compilar correctamente mediante el script `mascot:build`.
3. WHEN el Usuario presiona F5 en VS Code, THE Sistema SHALL abrir el Extension Development Host correctamente.
4. WHEN la Extensión inicia con `pluvianidae.enableMascot` en `true`, THE Mascota_De_Escritorio SHALL aparecer flotando en el escritorio del Usuario.
5. WHILE el Usuario cambia de aplicación activa en su sistema operativo, THE Mascota_De_Escritorio SHALL permanecer visible por encima de la aplicación activa.
6. THE Mascota_De_Escritorio SHALL poder arrastrarse por la pantalla mediante el mouse.
7. WHEN el Usuario reabre la Mascota_De_Escritorio tras una sesión previa, THE Mascota_De_Escritorio SHALL restaurar su posición anterior.
8. WHEN la Extensión emite un MascotEvent, THE Mascota_De_Escritorio SHALL recibir y reflejar dicho evento.
9. THE Mascota_De_Escritorio SHALL mostrar burbujas de texto para los eventos que incluyan un mensaje.
10. WHEN la Mascota_De_Escritorio recibe un MascotEvent de tipo `seed`, THE Mascota_De_Escritorio SHALL mostrar la animación de semillas.
11. THE Mascota_De_Escritorio SHALL poder ocultarse (`hide`) sin cerrarse completamente.
12. THE Mascota_De_Escritorio SHALL poder cerrarse (`stop`/`dispose`) completamente.
13. WHEN el Extension Development Host se cierra, THE Sistema SHALL NOT dejar ningún proceso de App_Electron huérfano en ejecución.
14. IF App_Electron falla al iniciar, THEN THE Extensión SHALL continuar funcionando con normalidad sin bloquearse.
