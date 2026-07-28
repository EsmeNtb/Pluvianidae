# 🐦 Pluvianidae

**Asistente inteligente de desarrollo para repositorios JavaScript/TypeScript.**

Pluvianidae es una extensión de VS Code que indexa, analiza y monitorea tu código en tiempo real. Detecta código muerto, compara contratos frontend-backend, revisa commits antes de que se hagan, genera documentación y te acompaña con una mascota de escritorio animada que reacciona a los eventos de tu flujo de trabajo.

---

## Características

| Módulo | Descripción |
|--------|-------------|
| **Indexador** | Indexación completa e incremental del repositorio con extracción de símbolos, imports/exports y endpoints REST |
| **Buscador semántico** | Búsqueda por lenguaje natural o texto exacto, potenciado por Amazon Bedrock |
| **Analizador de referencias** | Mapa completo de definición, imports, usos, llamadas y dependientes de cualquier símbolo |
| **Detector de código muerto** | Identifica funciones, variables y exports no utilizados con sugerencias de auto-fix |
| **Comparador frontend-backend** | Detecta endpoints sin consumir, llamadas sin endpoint, incompatibilidades de tipos y discrepancias |
| **Revisor pre-commit** | Análisis automático de cambios antes del commit: errores, advertencias, recomendaciones y detección de secretos |
| **Generador de README** | Genera o actualiza el README del repositorio usando IA |
| **Explicador de repositorio** | Resumen del stack, dependencias y flujo principal de la aplicación |
| **Motor de semillas** | Convierte hallazgos de análisis en "semillas" (recomendaciones accionables) con estados de ciclo de vida |
| **Mascota de escritorio** | App Electron independiente que muestra una mascota animada con burbujas de mensaje y menú contextual |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension                           │
│                                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────────────────┐ │
│  │ Event Bus│◄──│  Extension   │──►│       Analysis Modules       │ │
│  │ (pub/sub)│   │  (activate)  │   │  ┌─────────┐ ┌───────────┐  │ │
│  └────┬─────┘   └──────┬───────┘   │  │Indexador│ │Dead Code  │  │ │
│       │                 │           │  └─────────┘ └───────────┘  │ │
│       │                 │           │  ┌─────────┐ ┌───────────┐  │ │
│       │                 │           │  │Searcher │ │FB Compara.│  │ │
│       │                 │           │  └─────────┘ └───────────┘  │ │
│       │                 │           │  ┌─────────┐ ┌───────────┐  │ │
│       │                 │           │  │PreCommit│ │Ref Analyz.│  │ │
│       │                 │           │  └─────────┘ └───────────┘  │ │
│       │                 │           └─────────────────────────────┘ │
│       │                 │                                           │
│       │          ┌──────┴──────────────────┐                        │
│       │          │   Services              │                        │
│       │          │  ┌──────────────────┐   │                        │
│       └──────────┼─►│LocalMascotServer │   │                        │
│                  │  │ (HTTP/SSE)       │   │                        │
│                  │  └────────┬─────────┘   │                        │
│                  │  ┌────────┴─────────┐   │                        │
│                  │  │ BedrockClient    │   │                        │
│                  │  │ SecurityFilter   │   │                        │
│                  │  │ SeedEngine       │   │                        │
│                  │  └──────────────────┘   │                        │
│                  └─────────────────────────┘                        │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTP (127.0.0.1)
                            │ GET /events (SSE)
                            │ POST /actions
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Desktop Mascot (Electron)                          │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────────┐                   │
│  │  main.ts │◄──►│preload.ts│◄──►│ renderer.ts  │                   │
│  │(Electron)│    │(IPC brdg)│    │(DOM/animación)│                   │
│  └────┬─────┘    └──────────┘    └──────────────┘                   │
│       │                                                             │
│  ┌────┴──────────┐  ┌────────────────┐  ┌────────────────────┐     │
│  │sse-client.ts  │  │context-menu.ts │  │  window-state.ts   │     │
│  │(consume SSE)  │  │(6 acciones)    │  │(posición persistida)│     │
│  └───────────────┘  └────────────────┘  └────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### Comunicación extensión ↔ mascota

| Dirección | Transporte | Formato |
|-----------|-----------|---------|
| Extensión → Mascota | SSE (`GET /events`) | `MascotEvent` (idle, indexing, success, warning, error, seed, hide, show) |
| Mascota → Extensión | HTTP (`POST /actions`) | `MascotAction` (analyze-repository, precommit-review, show-seed-basket, mute-messages, hide-mascot, close-mascot) |

Ambos extremos validan mensajes con type guards estrictos (`isMascotEvent`, `isMascotAction`) antes de procesarlos. El servidor solo escucha en `127.0.0.1`.

### Event Bus

Sistema pub/sub sincrónico que desacopla todos los módulos. Eventos principales:

- `indexing:started` / `indexing:progress` / `indexing:completed`
- `analysis:finding`
- `seed:created` / `seed:updated`
- `mascot:animate`
- `precommit:completed`

---

## Estructura del proyecto

```
Pluvianidae/
├── src/
│   ├── extension.ts              # Punto de entrada, wiring de todos los módulos
│   ├── core/
│   │   ├── event-bus.ts          # Pub/sub sincrónico
│   │   └── models.ts             # Tipos compartidos (Finding, Seed, Config, etc.)
│   ├── modules/
│   │   ├── indexer/              # Indexación full + incremental
│   │   ├── searcher/             # Búsqueda semántica con Bedrock
│   │   ├── reference-analyzer/   # Análisis de referencias de símbolos
│   │   ├── dead-code-detector/   # Detección de código muerto + auto-fix
│   │   ├── frontend-backend-comparator/  # Validación de contratos API
│   │   ├── pre-commit-reviewer/  # Revisión pre-commit + detección de secretos
│   │   ├── readme-generator/     # Generación de README con IA
│   │   ├── explainer/            # Explicación del repositorio
│   │   └── seed-engine/          # Motor de semillas (hallazgos → acciones)
│   ├── presentation/
│   │   ├── mascot/               # Controller, animation engine, webview
│   │   └── seed-basket-view.ts   # TreeView del cesto de semillas
│   └── services/
│       ├── local-mascot-server.ts     # Servidor HTTP/SSE para la mascota
│       ├── desktop-mascot-manager.ts  # Lifecycle del proceso Electron
│       ├── mascot-action-dispatcher.ts
│       ├── bedrock-client.ts          # Cliente Amazon Bedrock
│       ├── security-filter.ts         # Filtrado de archivos sensibles
│       └── confirmation-service.ts
├── desktop-mascot/               # App Electron independiente
│   ├── src/
│   │   ├── main.ts              # Proceso principal (BrowserWindow, IPC)
│   │   ├── preload.ts           # Context bridge (aislamiento)
│   │   ├── renderer.ts          # Lógica de DOM, animaciones, burbujas
│   │   ├── sse-client.ts        # Cliente SSE con reconexión automática
│   │   ├── context-menu.ts      # Menú contextual (6 acciones)
│   │   ├── window-state.ts      # Persistencia de posición de ventana
│   │   └── single-instance.ts   # Garantía de instancia única
│   ├── index.html
│   ├── styles.css               # Animaciones CSS por estado visual
│   └── package.json
├── shared/
│   ├── mascot-events.ts         # Contrato MascotEvent (extensión → mascota)
│   └── mascot-actions.ts        # Contrato MascotAction (mascota → extensión)
├── tests/
│   ├── unit/                    # Tests unitarios por módulo
│   ├── property/                # Property-based tests (fast-check)
│   ├── integration/             # Tests de integración end-to-end
│   └── smoke/                   # Smoke tests
└── package.json
```

---

## Requisitos previos

- **Node.js** ≥ 18
- **npm** ≥ 9
- **VS Code** ≥ 1.85.0
- **Credenciales AWS** configuradas (para las funcionalidades con Amazon Bedrock)

---

## Instalación y uso

```bash
# 1. Instalar dependencias de la extensión
npm install

# 2. Instalar dependencias de la mascota Electron
npm run mascot:install

# 3. Compilar la extensión
npm run compile

# 4. Compilar la mascota de escritorio
npm run mascot:build

# 5. Ejecutar desde VS Code: F5 → Extension Development Host
```

---

## Desarrollo

```bash
# Desarrollo simultáneo (extensión + mascota con hot-reload)
npm run dev

# Solo la mascota en modo desarrollo
npm run mascot:dev

# Watch mode de la extensión (solo TypeScript)
npm run watch
```

---

## Tests

```bash
# Ejecutar toda la suite (unit + property + integration)
npm test

# Watch mode
npm run test:watch
```

La suite incluye:
- **Tests unitarios** — cobertura por módulo
- **Property-based tests** — validación formal de invariantes con [fast-check](https://github.com/dubzzz/fast-check)
- **Tests de integración** — flujos completos end-to-end

---

## Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `Pluvianidae: Buscar en el repositorio` | Búsqueda semántica o textual |
| `Pluvianidae: Analizar referencias` | Mapa de referencias del símbolo seleccionado |
| `Pluvianidae: Detectar código no utilizado` | Escaneo de código muerto con opción de auto-fix |
| `Pluvianidae: Comparar frontend-backend` | Validación de contratos API |
| `Pluvianidae: Revisión pre-commit` | Análisis de cambios pendientes + detección de secretos |
| `Pluvianidae: Generar README` | Genera/actualiza README con IA |
| `Pluvianidae: Explicar repositorio` | Resumen del stack y arquitectura |

---

## Configuración

| Setting | Default | Descripción |
|---------|---------|-------------|
| `pluvianidae.excludePatterns` | `[]` | Patrones de archivos a excluir del índice |
| `pluvianidae.bedrockRegion` | `us-east-1` | Región AWS para Bedrock |
| `pluvianidae.bedrockModelId` | `anthropic.claude-3-sonnet-20240229-v1:0` | Modelo de Bedrock |
| `pluvianidae.enableMascot` | `true` | Activa/desactiva la mascota de escritorio |
| `pluvianidae.confirmBeforeTransmit` | `true` | Confirmación antes de enviar código a Bedrock |
| `pluvianidae.persistIndex` | `false` | Persistir índice entre sesiones |
| `pluvianidae.maxIndexingTime` | `5000` | Timeout de indexación por archivo (ms) |
| `pluvianidae.maxPreCommitTime` | `60000` | Timeout de revisión pre-commit (ms) |

---

## Seguridad

- El servidor local de la mascota escucha **exclusivamente en `127.0.0.1`** (nunca expuesto a la red)
- Todo contenido renderizado en el DOM usa `textContent` (nunca `innerHTML`)
- Los mensajes entre procesos se validan con type guards estrictos antes de ser procesados
- Las acciones de la mascota son una allowlist cerrada sin parámetros de texto libre
- `SecurityFilter` excluye archivos sensibles (`.env`, claves privadas, etc.) de la indexación
- `confirmBeforeTransmit` requiere consentimiento explícito antes de enviar código a servicios externos

---

## Licencia

Propietario — Todos los derechos reservados.
