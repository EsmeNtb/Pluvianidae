# Implementation Plan: Pluvianidae MVP

## Overview

Implementation of the Pluvianidae VS Code extension — an intelligent development assistant for JavaScript/TypeScript repositories. The implementation follows a modular architecture with an Event Bus at the core, specialized analysis modules, a gamified seed presentation layer, and Amazon Bedrock integration. TypeScript is used throughout with Vitest for testing and fast-check for property-based tests.

## Tasks

- [x] 1. Set up project structure, core interfaces, and extension scaffold
  - [x] 1.1 Initialize VS Code extension project with TypeScript
    - Create extension scaffold with `package.json` (extension manifest), `tsconfig.json`, and entry point `src/extension.ts`
    - Configure Vitest and fast-check as dev dependencies
    - Set up directory structure: `src/core/`, `src/modules/`, `src/services/`, `src/presentation/`, `tests/`
    - Register placeholder commands in `package.json` contributes section
    - _Requirements: All (project foundation)_

  - [x] 1.2 Implement Event Bus (`src/core/event-bus.ts`)
    - Implement `IEventBus` interface with `emit`, `on`, `off` methods
    - Define `PluvianidaeEvent` union type with all event variants (indexing, analysis, seed, mascot)
    - Return `Disposable` from `on` for proper cleanup
    - _Requirements: All (cross-cutting communication)_

  - [x] 1.3 Define shared data models and interfaces (`src/core/models.ts`)
    - Implement `RepositoryIndex`, `FileEntry`, `SymbolEntry`, `ImportEntry`, `ExportEntry`, `EndpointEntry` interfaces
    - Implement `Seed`, `SeedState`, `Finding`, `AnalysisError` types
    - Implement `PluvianidaeConfig` configuration interface with defaults
    - Define `SymbolType`, `HttpMethod`, `ParameterInfo`, `TypeSchema` types
    - _Requirements: 1.2, 9.1, 9.2_

  - [x]* 1.4 Write property test for Event Bus ordering
    - **Property 22: Animation queue ordering**
    - **Validates: Requirements 10.7**

- [x] 2. Implement Indexador module
  - [x] 2.1 Implement file discovery and filtering (`src/modules/indexer/file-discovery.ts`)
    - Scan workspace for .js, .jsx, .ts, .tsx files
    - Exclude `node_modules`, `bower_components`, `.pnp` directories
    - Parse and apply `.gitignore` patterns for exclusion
    - Integrate with Security Filter for sensitive file exclusion
    - _Requirements: 1.1, 1.3, 1.4_

  - [x] 2.2 Implement AST-based symbol extraction (`src/modules/indexer/symbol-extractor.ts`)
    - Use TypeScript compiler API to parse source files
    - Extract functions, classes, components, imports, exports, endpoints
    - Build `SymbolEntry` records with location information (file, line, column)
    - Handle JSX/TSX component detection
    - _Requirements: 1.2_

  - [x] 2.3 Implement Repository Index builder (`src/modules/indexer/index-builder.ts`)
    - Construct `RepositoryIndex` from extracted symbols
    - Build import graph (`importGraph`) and export graph (`exportGraph`)
    - Detect Express/Node.js endpoints and populate `endpoints` array
    - Emit progress events via Event Bus during indexation
    - Handle syntax errors gracefully: log error, skip file, continue
    - _Requirements: 1.2, 1.5, 1.6_

  - [x] 2.4 Implement incremental indexing (`src/modules/indexer/incremental.ts`)
    - Register VS Code file watcher for .js/.jsx/.ts/.tsx files
    - On file create/modify: re-parse only the affected file and update index
    - On file delete: remove file entries and update dependency graphs
    - Ensure index consistency equivalent to full re-indexation
    - Enforce 5-second timeout per file for incremental updates
    - _Requirements: 1.7_

  - [x]* 2.5 Write property tests for Indexador
    - **Property 1: File extension and exclusion filtering**
    - **Validates: Requirements 1.1**

  - [x]* 2.6 Write property test for symbol extraction
    - **Property 2: Symbol extraction completeness**
    - **Validates: Requirements 1.2**

  - [x]* 2.7 Write property test for gitignore exclusion
    - **Property 3: Gitignore pattern exclusion**
    - **Validates: Requirements 1.3**

  - [x]* 2.8 Write property test for error resilience
    - **Property 5: Error resilience across modules**
    - **Validates: Requirements 1.6, 4.5, 5.7**

  - [x]* 2.9 Write property test for incremental index consistency
    - **Property 6: Incremental index consistency**
    - **Validates: Requirements 1.7**

- [x] 3. Implement Security Filter service
  - [x] 3.1 Implement Security Filter (`src/services/security-filter.ts`)
    - Implement `ISecurityFilter` interface with `shouldExclude`, `getExclusionPatterns`, `addUserExclusion`, `redactSensitiveValues`
    - Define default sensitive patterns: `.env*`, `*.pem`, `*.key`, `*.cert`, `*.p12`, `*.pfx`, `*.keystore`, `credentials.json`, `*_credentials.json`, `service-account*.json`, `*secret*`, `.ssh/*`, `.aws/*`
    - Implement glob pattern matching for user-configured exclusions
    - Implement value redaction for tokens, passwords, API keys, connection strings
    - _Requirements: 1.4, 11.1, 11.2, 11.5_

  - [x]* 3.2 Write property tests for Security Filter
    - **Property 4: Sensitive file exclusion**
    - **Validates: Requirements 1.4, 11.1, 11.2**

  - [x]* 3.3 Write property test for value redaction
    - **Property 23: Sensitive value redaction**
    - **Validates: Requirements 11.5**

- [x] 4. Checkpoint - Core indexing and security
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Buscador module
  - [x] 5.1 Implement Bedrock Client (`src/services/bedrock-client.ts`)
    - Implement `IBedrockClient` with `query` and `isAvailable` methods
    - Add user confirmation dialog before transmitting data (show file names and code snippets)
    - Handle timeout (10s), unavailability, and error responses
    - Support cancellation if user rejects transmission
    - _Requirements: 2.1, 11.3, 11.4_

  - [x] 5.2 Implement Buscador (`src/modules/searcher/searcher.ts`)
    - Implement `ISearcher` with `search` (semantic via Bedrock) and `searchExact` (textual fallback)
    - Build `SearchResult` objects with file name, full path, symbol name, code snippet (max 20 lines), explanation
    - Compute `relatedFiles` from the index import graph
    - Enforce 5-second response time limit
    - When no results: return suggestions for alternative queries
    - Fallback to `searchExact` when Bedrock unavailable
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 5.3 Write property tests for Buscador
    - **Property 7: Search result completeness**
    - **Validates: Requirements 2.2**

  - [x]* 5.4 Write property test for related files
    - **Property 8: Related files from import graph**
    - **Validates: Requirements 2.3**

- [x] 6. Implement Analizador de Referencias module
  - [x] 6.1 Implement Reference Analyzer (`src/modules/reference-analyzer/reference-analyzer.ts`)
    - Implement `IReferenceAnalyzer` with `getReferences` method
    - Build `ReferenceMap`: definition location, imports, usages, calls (first-level), dependents
    - Query repository index for symbol lookups
    - Handle symbol-not-found case: inform user with possible causes (file not indexed, external dependency)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x]* 6.2 Write property test for Reference Analyzer
    - **Property 9: Reference map completeness**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

- [x] 7. Implement Detector de Código No Utilizado module
  - [x] 7.1 Implement Dead Code Detector (`src/modules/dead-code-detector/dead-code-detector.ts`)
    - Implement `IDeadCodeDetector` with `analyze` method
    - Detect: unused imports, unused variables, unused parameters, unused functions, orphan files
    - Assign confidence levels: "alto" (zero refs), "medio" (only in comments/tests), "bajo" (dynamic/indirect)
    - Enforce 60-second timeout for analysis
    - Handle unanalyzable files gracefully (syntax errors)
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 7.2 Implement commented and duplicate code detection (`src/modules/dead-code-detector/code-warnings.ts`)
    - Detect commented blocks of 3+ consecutive lines
    - Detect duplicate blocks of 5+ lines with ≥80% similarity
    - Report as `CodeWarning` entries with confidence "bajo"
    - Include duplicate location information when applicable
    - _Requirements: 4.3_

  - [x] 7.3 Implement confirmation workflow for auto-fixes
    - Present proposed corrections to user before applying
    - Require explicit confirmation for each fix
    - _Requirements: 4.4, 11.6_

  - [x]* 7.4 Write property tests for Dead Code Detector
    - **Property 10: Dead code detection accuracy**
    - **Validates: Requirements 4.1, 4.2**

  - [x]* 7.5 Write property test for commented/duplicate thresholds
    - **Property 11: Commented and duplicate code thresholds**
    - **Validates: Requirements 4.3**

- [x] 8. Implement Comparador Frontend-Backend module
  - [x] 8.1 Implement backend endpoint extraction (`src/modules/frontend-backend-comparator/backend-extractor.ts`)
    - Parse Express/Node.js route definitions
    - Extract: route path, HTTP method, parameters, body schema, response types
    - Record file locations for all extracted data
    - _Requirements: 5.1_

  - [x] 8.2 Implement frontend API call extraction (`src/modules/frontend-backend-comparator/frontend-extractor.ts`)
    - Detect fetch, axios, custom hook HTTP calls
    - Extract: URL, HTTP method, sent data types, file location
    - Support environment variable URL patterns
    - _Requirements: 5.2_

  - [x] 8.3 Implement comparison engine (`src/modules/frontend-backend-comparator/comparator.ts`)
    - Implement `IFrontendBackendComparator` with `analyze` method
    - Match frontend calls to backend endpoints
    - Report: unconsumed endpoints, missing endpoints, type incompatibilities, discrepancies
    - Handle unanalyzable files gracefully
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x]* 8.4 Write property tests for endpoint extraction
    - **Property 12: Backend endpoint extraction**
    - **Validates: Requirements 5.1**

  - [x]* 8.5 Write property test for frontend call extraction
    - **Property 13: Frontend API call extraction**
    - **Validates: Requirements 5.2**

  - [x]* 8.6 Write property tests for mismatch detection
    - **Property 14: Connection mismatch detection**
    - **Validates: Requirements 5.3, 5.4**

  - [x]* 8.7 Write property test for type incompatibility
    - **Property 15: Type and method incompatibility detection**
    - **Validates: Requirements 5.5, 5.6**

- [x] 9. Checkpoint - Analysis modules complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement Revisor Pre-Commit module
  - [x] 10.1 Implement Pre-Commit Reviewer (`src/modules/pre-commit-reviewer/pre-commit-reviewer.ts`)
    - Implement `IPreCommitReviewer` with `review` method
    - Integrate with VS Code git API to get staged files
    - Run checks: linter, unit tests, compilation errors, broken imports, forgotten files, secrets, unused code
    - Classify findings: "error", "advertencia", "recomendación"
    - Enforce 60-second timeout with partial results reporting
    - Handle unavailable checks gracefully (report skipped with reason)
    - _Requirements: 6.1, 6.2, 6.4, 6.5_

  - [x] 10.2 Implement secret detection (`src/modules/pre-commit-reviewer/secret-detector.ts`)
    - Detect API keys, tokens, passwords in plain text, private key patterns
    - Block commit automatically when secrets detected
    - Require explicit user action to continue or cancel
    - Never include detected values in logs or reports
    - _Requirements: 6.3_

  - [x]* 10.3 Write property test for finding classification
    - **Property 16: Pre-commit finding classification**
    - **Validates: Requirements 6.2**

  - [x]* 10.4 Write property test for secret detection
    - **Property 17: Secret pattern detection**
    - **Validates: Requirements 6.3**

- [x] 11. Implement Generador de README module
  - [x] 11.1 Implement README Generator (`src/modules/readme-generator/readme-generator.ts`)
    - Implement `IReadmeGenerator` with `generateDraft` and `applyDraft` methods
    - Analyze repository for: description, tech stack, installation, env vars, scripts, folder structure, endpoints, run instructions
    - Use Bedrock for natural language descriptions
    - Omit sections when data is missing; report omitted sections to user
    - Enforce 30-second timeout
    - Show confirmation dialog before writing file
    - Preserve existing README if user rejects draft
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_

  - [x] 11.2 Implement diff generation for existing README
    - Compare generated draft against existing README
    - Show additions, removals, and modifications
    - Include diff in confirmation dialog
    - _Requirements: 7.4_

  - [x]* 11.3 Write property test for README diff
    - **Property 24: README diff generation**
    - **Validates: Requirements 7.4**

  - [x]* 11.4 Write property test for section omission
    - **Property 25: README section omission for missing data**
    - **Validates: Requirements 7.5**

- [x] 12. Implement Explicador de Repositorio module
  - [x] 12.1 Implement Repository Explainer (`src/modules/explainer/explainer.ts`)
    - Generate repository explanation: frontend stack, backend stack, main dependencies, application flow
    - Use Bedrock for natural language flow descriptions
    - Enforce 15-second timeout
    - Handle missing frontend/backend gracefully (include only applicable sections)
    - Handle Bedrock unavailability with retry option
    - Support re-explanation showing what changed since last explanation
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 13. Implement Motor de Semillas (Seed Engine)
  - [x] 13.1 Implement Seed Engine (`src/modules/seed-engine/seed-engine.ts`)
    - Implement `ISeedEngine` with `createSeed`, `updateState`, `getPendingSeeds`, `getSeedDetail`, `getAllSeeds`
    - Create seeds with initial state "Pendiente", type, source module, location, description, timestamp
    - Enforce valid state transitions: Pendiente→{En revisión, Resuelta, Ignorada}, En revisión→{Resuelta, Ignorada}
    - Reject invalid transitions
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 13.2 Implement Seed Store persistence (`src/modules/seed-engine/seed-store.ts`)
    - Implement `SeedStore` with `save` and `load` methods
    - Store seeds in memory during session
    - Serialize to disk only with user consent (respecting 11.7)
    - _Requirements: 9.1, 11.7_

  - [x] 13.3 Implement seed presentation (basket view) (`src/presentation/seed-basket-view.ts`)
    - Create VS Code TreeView or Webview showing pending seeds
    - Display total pending count
    - Allow user to view seed list without extra navigation
    - Show full detail when user selects a seed (description, location, suggested action)
    - _Requirements: 9.5, 9.7_

  - [x]* 13.4 Write property test for seed state machine
    - **Property 18: Seed state machine validity**
    - **Validates: Requirements 9.2, 9.4**

  - [x]* 13.5 Write property test for seed creation
    - **Property 19: Seed creation completeness**
    - **Validates: Requirements 9.1**

  - [x]* 13.6 Write property test for pending count
    - **Property 20: Pending seed count consistency**
    - **Validates: Requirements 9.5**

- [x] 14. Implement Mascota (Mascot) module
  - [x] 14.1 Implement Mascot Controller (`src/presentation/mascot/mascot-controller.ts`)
    - Implement `IMascotController` with `show`, `hide`, `animate`, `positionNear`
    - Position mascot in corner without overlapping editable content or interactive controls
    - Support hide/restore toggle with persistent restore control
    - _Requirements: 10.1, 10.6_

  - [x] 14.2 Implement animation engine (`src/presentation/mascot/animation-engine.ts`)
    - Support animations: idle, analysis-complete, carrying-seed, celebration, perch-on-file
    - Enforce max 3-second duration for analysis-complete and celebration before returning to idle
    - Process animation queue in arrival order without omitting events
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 10.7_

  - [x] 14.3 Implement Mascot Webview (`src/presentation/mascot/mascot-webview.ts`)
    - Create VS Code Webview panel for mascot rendering
    - Render animated mascot (bird) with CSS/SVG animations
    - Wire Event Bus events to mascot animations (seed created → carrying-seed, analysis complete → celebration, etc.)
    - Show carrying-seed visual when pending seeds exist
    - _Requirements: 9.6, 10.2, 10.3, 10.5_

  - [x]* 14.4 Write property test for carrying-seed indicator
    - **Property 21: Mascot carrying-seed indicator**
    - **Validates: Requirements 9.6**

- [x] 15. Checkpoint - All modules implemented
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Wire extension entry point and integrate all modules
  - [x] 16.1 Implement extension activation (`src/extension.ts`)
    - Register all VS Code commands (search, analyze references, detect dead code, compare frontend-backend, pre-commit review, generate README, explain repository)
    - Initialize Event Bus and inject into all modules
    - Trigger indexation on workspace open
    - Set up file watchers for incremental indexing
    - Load configuration from VS Code settings
    - Wire analysis findings → seed creation → mascot animations via Event Bus
    - _Requirements: 1.1, 1.5, 1.7_

  - [x] 16.2 Implement user-facing confirmation dialogs (`src/services/confirmation-service.ts`)
    - Bedrock transmission confirmation (show files/snippets being sent)
    - File modification confirmation (show proposed changes)
    - Commit blocking dialog for secrets
    - Centralize all user confirmation flows
    - _Requirements: 11.3, 11.4, 11.6_

  - [x] 16.3 Implement VS Code UI integration
    - Register TreeView providers for seed basket
    - Register status bar items for indexing progress
    - Register diagnostic decorations for findings
    - Configure extension settings schema in `package.json`
    - _Requirements: 1.5, 9.5, 10.1_

  - [x]* 16.4 Write integration tests for full workflow
    - Test indexation → search → results flow
    - Test finding generation → seed creation → mascot animation flow
    - Test pre-commit with mock git staging area
    - _Requirements: All (end-to-end validation)_

- [x] 17. Final checkpoint - Full integration verified
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All modules communicate via the Event Bus for decoupled architecture
- Amazon Bedrock integration is opt-in with user confirmation at every step
- Security Filter is applied across all modules to protect sensitive files

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "3.1"] },
    { "id": 3, "tasks": ["2.1", "3.2", "3.3"] },
    { "id": 4, "tasks": ["2.2", "2.5"] },
    { "id": 5, "tasks": ["2.3", "2.6", "2.7"] },
    { "id": 6, "tasks": ["2.4", "2.8"] },
    { "id": 7, "tasks": ["2.9", "5.1"] },
    { "id": 8, "tasks": ["5.2", "6.1", "7.1"] },
    { "id": 9, "tasks": ["5.3", "5.4", "6.2", "7.2"] },
    { "id": 10, "tasks": ["7.3", "7.4", "7.5", "8.1", "8.2"] },
    { "id": 11, "tasks": ["8.3", "8.4", "8.5"] },
    { "id": 12, "tasks": ["8.6", "8.7", "10.1"] },
    { "id": 13, "tasks": ["10.2", "10.3", "10.4"] },
    { "id": 14, "tasks": ["11.1", "12.1"] },
    { "id": 15, "tasks": ["11.2", "11.3", "11.4"] },
    { "id": 16, "tasks": ["13.1"] },
    { "id": 17, "tasks": ["13.2", "13.3", "13.4", "13.5", "13.6"] },
    { "id": 18, "tasks": ["14.1"] },
    { "id": 19, "tasks": ["14.2", "14.3", "14.4"] },
    { "id": 20, "tasks": ["16.1"] },
    { "id": 21, "tasks": ["16.2", "16.3"] },
    { "id": 22, "tasks": ["16.4"] }
  ]
}
```
