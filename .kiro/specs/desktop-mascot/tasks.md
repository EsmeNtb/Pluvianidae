# Implementation Plan: Desktop Mascot (Electron)

## Overview

Implementación de la mascota de Pluvianidae como aplicación de escritorio Electron independiente, sustituyendo su vida actual dentro de una webview del editor. Sigue la arquitectura de tres componentes descrita en `design.md`: Extensión (`src/`), App Electron (`desktop-mascot/`) y contratos compartidos (`shared/`), comunicados vía un servidor HTTP local (SSE + `/actions`) restringido a `127.0.0.1`. Usa TypeScript en todo el proyecto, Vitest para pruebas y fast-check para pruebas de propiedades, consistente con el resto del repositorio.

## Tasks

- [x] 1. Definir el contrato compartido de acciones (`shared/mascot-actions.ts`)
  - [x] 1.1 Implementar `MascotAction`, `MASCOT_ACTION_TYPES`, `isMascotAction`, `serializeMascotAction`, `deserializeMascotAction`
    - Seguir exactamente el mismo patrón de `shared/mascot-events.ts` (unión cerrada, type guard exhaustivo, sin campos adicionales permitidos)
    - No modificar `shared/mascot-events.ts` (ya coincide con el contrato requerido; sólo se consume)
    - _Requirements: 4.2, 4.3_

  - [x]* 1.2 Escribir pruebas de propiedad para validación de esquema y serialización de `MascotAction`
    - **Property 1: Rechazo seguro de mensajes inválidos** (parte de esquema)
    - Además: *para cualquier* `MascotAction` válido, `deserializeMascotAction(serializeMascotAction(a))` es estructuralmente igual a `a`
    - **Validates: Requirements 3.4, 3.5, 4.3, 12.1, 12.2**

- [x] 2. Instalar Electron y dependencias de la app de escritorio (tarea temprana, obligatoria antes de cualquier código de Electron)
  - [x] 2.1 Crear la estructura mínima de `desktop-mascot/` (`package.json`, `tsconfig.json`, carpetas `src/`, `assets/`, `index.html`, `styles.css`)
    - `package.json` con `electron` como devDependency de versión exacta fijada, sin workspaces con la raíz
    - `tsconfig.json` con `rootDir`/`include` que permitan importar `../../shared/*.ts` sin copiarlo
    - _Requirements: 2.5, 10.1_

  - [x] 2.2 Añadir y documentar el script `mascot:install` en el `package.json` raíz
    - `mascot:install` SHALL ejecutar `npm install` dentro de `desktop-mascot/`
    - _Requirements: 10.1_

  - [x] 2.3 Ejecutar `npm run mascot:install` y verificar que `electron` queda instalado en `desktop-mascot/node_modules`
    - Ninguna tarea posterior que compile o ejecute código de `desktop-mascot/` debe iniciarse antes de completar esta verificación
    - _Requirements: 10.1_

- [x] 3. Implementar el servidor de comunicación local en la Extensión (`src/services/local-mascot-server.ts`)
  - [x] 3.1 Implementar `startLocalMascotServer` (escucha exclusiva en `127.0.0.1`, autodetección de puerto ante `EADDRINUSE`)
    - Endpoint `GET /events` como stream SSE, endpoint `POST /actions` con cuerpo JSON
    - Nunca escuchar en `0.0.0.0` ni interfaz distinta de loopback (comentario explícito en el código)
    - _Requirements: 3.1, 3.6_

  - [x] 3.2 Implementar `broadcast(event)` y validación de mensajes salientes/entrantes con los type guards de `shared/`
    - Validar cada `MascotEvent` con `isMascotEvent` antes de difundirlo; validar cada `POST /actions` con `isMascotAction` antes de reenviarlo al dispatcher
    - Mensajes inválidos: descartar, loggear, mantener la conexión abierta (nunca cerrar el socket ni lanzar una excepción no controlada)
    - _Requirements: 3.4, 3.5_

  - [x]* 3.3 Escribir pruebas de propiedad y unitarias para el servidor local
    - **Property 1: Rechazo seguro de mensajes inválidos**
    - **Property 2: Orden y no pérdida de eventos difundidos**
    - Prueba unitaria: autodetección de puerto libre ante `EADDRINUSE` simulado
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 12.1, 12.3**

- [x] 4. Implementar `DesktopMascotManager` (`src/services/desktop-mascot-manager.ts`)
  - [x] 4.1 Implementar la máquina de estados (`idle`/`starting`/`running`/`stopping`/`stopped`/`unavailable`) y los métodos públicos `start()`, `stop()`, `show()`, `hide()`, `send(event)`, `dispose()`
    - `start()` orquesta `LocalMascotServer` + `spawn` del proceso Electron; nunca lanza excepciones, cualquier fallo transiciona a `unavailable` con logging
    - `send()`/`show()`/`hide()` son no-ops seguros fuera del estado `running`
    - `dispose()` libera listeners del Event Bus y ejecuta la limpieza de recursos de mejor esfuerzo (ver tarea 4.2)
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 4.2 Implementar limpieza garantizada de recursos y reintentos periódicos de reconexión
    - Orden de limpieza: cancelar timers, cerrar servidor, `SIGTERM` con timeout de gracia al proceso hijo, `SIGKILL` si no responde, eliminar archivo de puerto (best-effort)
    - Si alguna operación de limpieza individual falla, continuar con las demás en vez de abortar la disposición completa (limpieza de mejor esfuerzo, con estados intermedios permitidos)
    - Mientras el manager esté en `unavailable`, reintentar periódicamente `start()` en segundo plano en vez de deshabilitar la funcionalidad de forma permanente
    - _Requirements: 8.3, 9.4_

  - [x]* 4.3 Escribir pruebas de propiedad y unitarias para `DesktopMascotManager`
    - **Property 5: Fail-safe en el arranque**
    - Prueba unitaria: cobertura completa de la máquina de estados, incluyendo la rama `starting → unavailable`
    - Prueba unitaria: tras `dispose()`, no queda ningún proceso hijo vivo (usando un proceso hijo de prueba simulado, no Electron real)
    - **Validates: Requirements 8.3, 9.4, 12.6, 12.7, 12.8, 13.14**

- [x] 5. Implementar la ventana Electron (`desktop-mascot/src/main.ts`)
  - [x] 5.1 Configurar `BrowserWindow` con todas las propiedades requeridas
    - `alwaysOnTop: true` (+ `setAlwaysOnTop(true, 'screen-saver')`), `transparent: true`, `frame: false`, `skipTaskbar: true`, `resizable/maximizable/minimizable: false`, `hasShadow: false`, tamaño 260x240
    - `webPreferences`: `preload` vía `path.join`, `contextIsolation: true`, `nodeIntegration: false`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 9.1_

  - [x] 5.2 Implementar el bloqueo de instancia única (`app.requestSingleInstanceLock()`)
    - Si el lock falla, el proceso recién lanzado SHALL hacer `app.quit()` sin crear ventana visible
    - Si el propio mecanismo de bloqueo falla por una causa ajena al feature, permitir que los procesos coexistan en vez de intentar detectarlos activamente
    - _Requirements: 3.7_

  - [x]* 5.3 Escribir prueba de propiedad para instancia única
    - **Property 4: Instancia única de Electron**
    - **Validates: Requirements 3.7, 12.5**

- [x] 6. Implementar posicionamiento inicial y persistencia de posición (`desktop-mascot/src/window-state.ts`)
  - [x] 6.1 Calcular posición inicial por defecto con `screen.getPrimaryDisplay().workArea` (esquina inferior derecha)
    - _Requirements: 1.8_

  - [x] 6.2 Implementar guardado debounced de posición (`window-position.json` vía `path.join(app.getPath('userData'), ...)`) y restauración validada contra `screen.getAllDisplays()`
    - Posición guardada fuera de todos los displays conectados: descartar, usar posición por defecto
    - _Requirements: 1.9, 1.10_

  - [x] 6.3 Implementar arrastre de la ventana (CSS `-webkit-app-region: drag` en el contenedor raíz, `no-drag` en burbuja/menú)
    - _Requirements: 1.10, 7.1_

  - [x]* 6.4 Escribir prueba de propiedad para persistencia de posición
    - **Property 6: Posición de ventana siempre dentro de un display válido**
    - **Validates: Requirements 1.9, 12.9, 13.7**

- [x] 7. Implementar el cliente de comunicación en Electron (`desktop-mascot/src/sse-client.ts`)
  - [x] 7.1 Implementar `maintainConnection(port)` con reconexión automática y backoff exponencial acotado
    - Usar `http.request` propio (no `EventSource` del navegador) para que la lógica de reconexión sea testeable
    - Validar cada mensaje recibido con `deserializeMascotEvent`; descartar y loggear mensajes inválidos sin cerrar el bucle de reintentos
    - _Requirements: 3.3, 3.4, 3.5_

  - [x] 7.2 Implementar heartbeat de autoterminación (`app.quit()` si no hay eventos ni reconexión exitosa tras `HEARTBEAT_TIMEOUT_MS`)
    - _Requirements: 9.4_

  - [x]* 7.3 Escribir pruebas de propiedad para reconexión
    - **Property 3: Backoff de reconexión acotado**
    - **Validates: Requirements 3.3, 12.4**

- [x] 8. Implementar el preload y la API expuesta al renderer (`desktop-mascot/src/preload.ts`, `desktop-mascot/src/ipc-channels.ts`)
  - [x] 8.1 Exponer `window.pluvianidae = { onMascotEvent(cb), sendAction(action) }` vía `contextBridge.exposeInMainWorld`
    - Validar cada `MascotAction` con `isMascotAction` antes de reenviar al proceso `main`
    - No exponer ninguna referencia a `require`, `process` u otras APIs de Node al renderer
    - _Requirements: 9.1, 9.2_

  - [x] 8.2 Validar en `main.ts` cada mensaje IPC recibido antes de actuar sobre él
    - _Requirements: 9.2_

- [x] 9. Implementar estados visuales y animaciones (`desktop-mascot/src/renderer.ts`, `desktop-mascot/styles.css`)
  - [x] 9.1 Implementar el mapeo evento → clase de animación para los 7 estados (idle, thinking, working, success, warning, error, sleeping)
    - Usar emoji o asset ya existente de la mascota, sin arte nuevo
    - Cualquier `MascotEvent` cuyo `type` no coincida con ningún mapeo definido SHALL caer al estado idle por defecto
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 9.2 Escribir pruebas unitarias del mapeo evento → animación, incluyendo el caso de tipo no reconocido
    - _Requirements: 5.2_

- [x] 10. Implementar burbujas de mensaje
  - [x] 10.1 Renderizar la burbuja con `textContent` para el texto del mensaje, tooltip (`title`) con el texto completo, y auto-ocultado tras un tiempo fijo
    - `innerHTML` permitido únicamente para markup estático de confianza (bordes/iconos), nunca para el texto proveniente de un `MascotEvent`
    - Sin panel oscuro grande
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 10.2 Escribir prueba unitaria que verifique que el texto de la burbuja se inserta exclusivamente vía `textContent` (prevención XSS)
    - _Requirements: 6.3_

- [x] 11. Implementar el menú contextual con allowlist (`desktop-mascot/src/context-menu.ts`)
  - [x] 11.1 Construir el menú nativo de Electron con exactamente las 6 opciones permitidas, cada una mapeada a un único `MascotAction`
    - _Requirements: 7.2, 7.3_

  - [x] 11.2 Implementar el comportamiento de "Ocultar mascota" (oculta sin cerrar proceso) y "Cerrar mascota" (cierre completo del ciclo de vida)
    - _Requirements: 7.4, 7.5_

  - [x]* 11.3 Escribir prueba de propiedad para la allowlist de acciones
    - **Property 7: Allowlist estricta de acciones**
    - **Validates: Requirements 7.2, 9.5, 12.10**

- [x] 12. Implementar el dispatcher de acciones en la Extensión (`src/services/mascot-action-dispatcher.ts`)
  - [x] 12.1 Implementar la tabla estática de mapeo `MascotAction` → comando VS Code / efecto local del manager
    - `analyze-repository` → `pluvianidae.explainRepository`, `precommit-review` → `pluvianidae.preCommitReview`, `show-seed-basket` → foco en la vista del cesto de semillas, `mute-messages` → flag local en el manager, `hide-mascot` → `desktopMascotManager.hide()`, `close-mascot` → `desktopMascotManager.stop()`
    - Rechazar (sin ejecutar nada) cualquier valor de `action` que no pertenezca a la allowlist, revalidando con `isMascotAction` antes de despachar
    - _Requirements: 7.3, 9.5_

  - [x] 12.2 Escribir pruebas unitarias del dispatcher (mapeo exhaustivo de las 6 acciones con `vscode.commands.executeCommand` mockeado, y rechazo de acciones fuera de la allowlist)
    - _Requirements: 7.3, 9.5, 12.10_

- [x] 13. Integrar eventos de los módulos existentes hacia la mascota de escritorio
  - [x] 13.1 Implementar `mascot-event-mapper.ts` (función pura, sin dependencia de `vscode`) con la tabla completa de mapeo evento interno → `MascotEvent`
    - Cubrir: inicio/fin de indexación, hallazgo de código no utilizado, hallazgo frontend-backend, detección de secretos, fin de revisión pre-commit, error no controlado, finalización de una acción, generación de semillas
    - _Requirements: 8.2_

  - [x] 13.2 Implementar `wireDesktopMascotToEventBus` y conectarlo en `extension.ts`, respetando `pluvianidae.enableMascot`
    - Si `pluvianidae.enableMascot` es `false`, no construir ni iniciar `DesktopMascotManager` en absoluto
    - Ocultar/deshabilitar los elementos de interfaz relacionados con la mascota mientras el manager esté en `unavailable`
    - No modificar la forma en que `indexer`, `dead-code-detector`, `frontend-backend-comparator`, `pre-commit-reviewer`, `secret-detector`, `readme-generator` ni `explainer` emiten sus propios eventos
    - _Requirements: 8.2, 8.4, 11.1_

  - [ ]* 13.3 Escribir pruebas unitarias del mapeo de eventos y prueba de integración de orden de entrega
    - Prueba unitaria: cada evento interno de la tabla produce el `MascotEvent` esperado
    - **Property 2: Orden y no pérdida de eventos difundidos** (aplicada de extremo a extremo: Event Bus → `DesktopMascotManager.send` → servidor → cliente SSE de prueba)
    - **Validates: Requirements 3.2, 8.2, 12.3**

- [x] 14. Desconectar `mascot-webview.ts` como mascota principal sin eliminarla
  - [x] 14.1 Retirar la llamada a `mascotController.show()` ligada a `enableMascot` en `extension.ts`, sustituyéndola por el arranque de `DesktopMascotManager`
    - No eliminar `src/presentation/mascot/mascot-webview.ts`, `mascot-controller.ts` ni `animation-engine.ts`, ni sus pruebas existentes (`tests/property/mascot-webview.property.test.ts`)
    - _Requirements: 11.2, 11.3_

  - [x] 14.2 Verificar que ningún módulo existente (`indexer`, `searcher`, `reference-analyzer`, `dead-code-detector`, `frontend-backend-comparator`, `pre-commit-reviewer`, `secret-detector`, `readme-generator`, `explainer`) cambió su comportamiento observable
    - Ejecutar la suite de pruebas completa existente y confirmar que sigue en verde
    - _Requirements: 11.1_

- [ ] 15. Añadir y documentar los scripts npm restantes
  - [x] 15.1 Añadir `mascot:dev` (compila `desktop-mascot/` en watch + `electron .`) y `mascot:build` (compila `desktop-mascot/` a `dist/`) en `desktop-mascot/package.json`, delegados desde scripts homónimos en el `package.json` raíz
    - _Requirements: 10.2, 10.3_

  - [x] 15.2 Añadir `dev` en el `package.json` raíz (ejecuta `watch` de la extensión y `mascot:dev` en paralelo)
    - _Requirements: 10.4_

  - [-] 15.3 Verificar que `compile` sigue compilando únicamente la Extensión hacia `out/src/extension.js`, y que `test` sigue ejecutando la suite completa incluyendo los tests nuevos de este feature
    - _Requirements: 10.5, 10.6_

- [ ] 16. Pruebas de integración de extremo a extremo y verificación de procesos huérfanos
  - [ ] 16.1 Escribir prueba de integración: arrancar `LocalMascotServer` real en puerto efímero, conectar un cliente SSE de prueba (sin Electron real), enviar una secuencia de `MascotEvent` vía `DesktopMascotManager.send(...)` y verificar orden/no pérdida
    - _Requirements: 12.3_

  - [ ] 16.2 Escribir prueba de integración: enviar `POST /actions` de prueba y verificar que el dispatcher ejecuta el comando VS Code esperado (mockeado), y que una acción fuera de la allowlist es rechazada
    - _Requirements: 12.10_

  - [ ] 16.3 Escribir prueba de integración: arrancar y detener `DesktopMascotManager` con un proceso hijo Node de prueba (no Electron completo, para no depender de entorno gráfico en CI) que simula éxito/fallo de arranque, verificando que no quedan procesos vivos tras `dispose()`
    - _Requirements: 12.5, 12.7, 13.13_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP, though property/unit tests for security-critical paths (message validation, allowlist, XSS prevention) are strongly recommended.
- Task 2 (instalación de Electron) es un prerrequisito explícito y bloqueante: ninguna tarea de las secciones 5-11 que compile o ejecute código dentro de `desktop-mascot/` puede iniciarse antes de completar 2.3.
- La Extensión (`src/`) y la App Electron (`desktop-mascot/`) se desarrollan como paquetes independientes; las tareas de cada lado pueden avanzar en paralelo una vez completado el contrato compartido (tarea 1) y la instalación de Electron (tarea 2).
- `mascot-webview.ts` y sus pruebas existentes nunca se eliminan como parte de este feature (ver tarea 14).
- Ningún módulo existente (indexer, searcher, reference-analyzer, dead-code-detector, frontend-backend-comparator, pre-commit-reviewer, secret-detector, readme-generator, explainer) cambia su forma de emitir eventos; sólo se añade un listener adicional en `extension.ts`.
- Property tests validate universal correctness properties from design.md; unit tests validate specific examples and edge cases (incluyendo los clarificados durante el análisis de requirements: fallback a idle, mejor esfuerzo en limpieza, reintentos periódicos, coexistencia si el lock falla).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2"] },
    { "id": 2, "tasks": ["2.3"] },
    { "id": 3, "tasks": ["3.1", "5.1", "6.1"] },
    { "id": 4, "tasks": ["3.2", "5.2", "6.2", "8.1"] },
    { "id": 5, "tasks": ["3.3", "4.1", "5.3", "6.3", "7.1", "8.2", "9.1", "10.1", "11.1"] },
    { "id": 6, "tasks": ["4.2", "6.4", "7.2", "9.2", "10.2", "11.2"] },
    { "id": 7, "tasks": ["4.3", "7.3", "11.3", "12.1"] },
    { "id": 8, "tasks": ["12.2", "13.1", "14.1"] },
    { "id": 9, "tasks": ["13.2", "14.2"] },
    { "id": 10, "tasks": ["13.3", "15.1"] },
    { "id": 11, "tasks": ["15.2"] },
    { "id": 12, "tasks": ["15.3"] },
    { "id": 13, "tasks": ["16.1", "16.2", "16.3"] }
  ]
}
```
