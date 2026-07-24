/**
 * Shared data models and interfaces for Pluvianidae.
 *
 * Shapes are taken directly from design.md ("Data Models" and component
 * interface sections) so that all modules (Indexador, Seed Engine, Event Bus,
 * etc.) share a single, consistent source of truth for cross-cutting types.
 */

// ---------------------------------------------------------------------------
// Repository Index (design.md > "Data Models" > "Repository Index")
// ---------------------------------------------------------------------------

export interface RepositoryIndex {
  rootPath: string;
  files: Map<string, FileEntry>;
  symbols: Map<string, SymbolEntry>;
  /** filePath -> [imported file paths] */
  importGraph: Map<string, string[]>;
  exportGraph: Map<string, ExportedSymbol[]>;
  endpoints: EndpointEntry[];
  lastUpdated: Date;
}

export interface FileEntry {
  path: string;
  relativePath: string;
  extension: string;
  lastModified: Date;
  /** IDs de símbolos en este archivo */
  symbols: string[];
  imports: ImportEntry[];
  exports: ExportEntry[];
}

export interface SymbolEntry {
  id: string;
  name: string;
  type: SymbolType;
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  parameters?: ParameterInfo[];
  returnType?: string;
}

export type SymbolType =
  | 'function'
  | 'class'
  | 'component'
  | 'variable'
  | 'type'
  | 'interface'
  | 'enum'
  | 'endpoint';

export interface ImportEntry {
  /** módulo importado */
  source: string;
  /** símbolos importados */
  specifiers: string[];
  isDefault: boolean;
  line: number;
}

export interface ExportEntry {
  name: string;
  isDefault: boolean;
  line: number;
}

export interface ExportedSymbol {
  name: string;
  filePath: string;
  isDefault: boolean;
}

export interface EndpointEntry {
  route: string;
  method: HttpMethod;
  filePath: string;
  line: number;
  parameters: ParameterInfo[];
  bodySchema?: TypeSchema;
  responseSchema?: TypeSchema;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ParameterInfo {
  name: string;
  type: string;
  required: boolean;
  source: 'query' | 'params' | 'body' | 'header';
}

export interface TypeSchema {
  type: string;
  properties?: Record<string, TypeSchema>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// Symbol location (design.md > "5. Analizador de Referencias")
// ---------------------------------------------------------------------------

export interface SymbolLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface SymbolUsage extends SymbolLocation {
  /** fragmento de código alrededor del uso */
  context: string;
}

// ---------------------------------------------------------------------------
// Indexer error (design.md > "3. Indexador")
// ---------------------------------------------------------------------------

export interface IndexError {
  filePath: string;
  description: string;
  line?: number;
}

// ---------------------------------------------------------------------------
// Findings (design.md > Event Bus "analysis:finding" payload and
// "10. Motor de Semillas" > ISeedEngine.createSeed(finding: Finding))
//
// Individual modules (Dead Code Detector, Pre-Commit Reviewer, etc.) define
// their own richer finding shapes (DeadCodeFinding, PreCommitFinding, ...).
// `Finding` is the generic shape that generalizes across all modules for use
// by the Event Bus and Seed Engine.
// ---------------------------------------------------------------------------

export interface Finding {
  type: string;
  sourceModule: string;
  filePath?: string;
  line?: number;
  description: string;
  suggestedAction?: string;
  confidence?: 'alto' | 'medio' | 'bajo';
}

// ---------------------------------------------------------------------------
// Seed Engine (design.md > "10. Motor de Semillas")
// ---------------------------------------------------------------------------

export type SeedState = 'Pendiente' | 'En revisión' | 'Resuelta' | 'Ignorada';

export interface Seed {
  id: string;
  type: 'recomendación' | 'tip' | 'problema' | 'review';
  sourceModule: string;
  location?: SymbolLocation;
  description: string;
  suggestedAction?: string;
  state: SeedState;
  createdAt: Date;
  updatedAt: Date;
}

/** Valid seed state transitions. */
export const VALID_SEED_TRANSITIONS: Record<SeedState, SeedState[]> = {
  Pendiente: ['En revisión', 'Resuelta', 'Ignorada'],
  'En revisión': ['Resuelta', 'Ignorada'],
  Resuelta: [],
  Ignorada: [],
};

// ---------------------------------------------------------------------------
// Mascota Controller (design.md > "11. Mascota Controller")
// ---------------------------------------------------------------------------

export type MascotAnimation =
  | { type: 'idle' }
  | { type: 'analysis-complete' }
  | { type: 'carrying-seed' }
  | { type: 'celebration' }
  | { type: 'perch-on-file'; filePath: string };

// ---------------------------------------------------------------------------
// Error Handling (design.md > "Error Handling" > "Patrón de error en reportes")
// ---------------------------------------------------------------------------

export interface AnalysisError {
  module: string;
  filePath: string;
  description: string;
  severity: 'fatal' | 'recoverable' | 'warning';
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Configuration (design.md > "Data Models" > "Configuration")
// ---------------------------------------------------------------------------

export interface PluvianidaeConfig {
  excludePatterns: string[];
  bedrockRegion: string;
  bedrockModelId: string;
  enableMascot: boolean;
  confirmBeforeTransmit: boolean;
  persistIndex: boolean;
  maxIndexingTime: number;
  maxPreCommitTime: number;
}

/** Sensible defaults for `PluvianidaeConfig`. */
export const DEFAULT_CONFIG: PluvianidaeConfig = {
  excludePatterns: [],
  bedrockRegion: 'us-east-1',
  bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  enableMascot: true,
  confirmBeforeTransmit: true,
  persistIndex: false,
  maxIndexingTime: 5000,
  maxPreCommitTime: 60000,
};
