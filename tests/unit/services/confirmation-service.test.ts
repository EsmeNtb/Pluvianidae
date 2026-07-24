import { describe, it, expect } from 'vitest';
import {
  IConfirmationPrompt,
  VsCodeConfirmationPrompt,
  IFixConfirmationPrompt,
  VsCodeFixConfirmationPrompt,
  ISecretConfirmationPrompt,
  VsCodeSecretConfirmationPrompt,
  SecretCommitGate,
  IReadmeConfirmationPrompt,
  VsCodeReadmeConfirmationPrompt,
  ISeedPersistenceConsent,
  VsCodeSeedPersistenceConsent,
  FileModificationProposal,
  IFileModificationConfirmation,
  VsCodeFileModificationConfirmation,
} from '../../../src/services/confirmation-service';

import * as BedrockClientModule from '../../../src/services/bedrock-client';
import * as FixConfirmationModule from '../../../src/modules/dead-code-detector/fix-confirmation';
import * as SecretDetectorModule from '../../../src/modules/pre-commit-reviewer/secret-detector';
import * as ReadmeGeneratorModule from '../../../src/modules/readme-generator/readme-generator';
import * as SeedStoreModule from '../../../src/modules/seed-engine/seed-store';

describe('confirmation-service re-exports', () => {
  it('re-exports VsCodeConfirmationPrompt as the exact same class as bedrock-client.ts', () => {
    expect(VsCodeConfirmationPrompt).toBe(BedrockClientModule.VsCodeConfirmationPrompt);
    const instance = new VsCodeConfirmationPrompt();
    expect(instance).toBeInstanceOf(BedrockClientModule.VsCodeConfirmationPrompt);
  });

  it('re-exports VsCodeFixConfirmationPrompt as the exact same class as fix-confirmation.ts', () => {
    expect(VsCodeFixConfirmationPrompt).toBe(FixConfirmationModule.VsCodeFixConfirmationPrompt);
    const instance = new VsCodeFixConfirmationPrompt();
    expect(instance).toBeInstanceOf(FixConfirmationModule.VsCodeFixConfirmationPrompt);
  });

  it('re-exports VsCodeSecretConfirmationPrompt and SecretCommitGate as the exact same classes as secret-detector.ts', () => {
    expect(VsCodeSecretConfirmationPrompt).toBe(SecretDetectorModule.VsCodeSecretConfirmationPrompt);
    expect(SecretCommitGate).toBe(SecretDetectorModule.SecretCommitGate);

    const prompt = new VsCodeSecretConfirmationPrompt();
    expect(prompt).toBeInstanceOf(SecretDetectorModule.VsCodeSecretConfirmationPrompt);

    const gate = new SecretCommitGate(prompt);
    expect(gate).toBeInstanceOf(SecretDetectorModule.SecretCommitGate);
  });

  it('re-exports VsCodeReadmeConfirmationPrompt as the exact same class as readme-generator.ts', () => {
    expect(VsCodeReadmeConfirmationPrompt).toBe(ReadmeGeneratorModule.VsCodeReadmeConfirmationPrompt);
    const instance = new VsCodeReadmeConfirmationPrompt();
    expect(instance).toBeInstanceOf(ReadmeGeneratorModule.VsCodeReadmeConfirmationPrompt);
  });

  it('re-exports VsCodeSeedPersistenceConsent as the exact same class as seed-store.ts', () => {
    expect(VsCodeSeedPersistenceConsent).toBe(SeedStoreModule.VsCodeSeedPersistenceConsent);
    const instance = new VsCodeSeedPersistenceConsent();
    expect(instance).toBeInstanceOf(SeedStoreModule.VsCodeSeedPersistenceConsent);
  });

  it('type-only interfaces remain usable as types via the re-export (structural check)', () => {
    // These are compile-time-only checks: if the re-exported interfaces
    // didn't structurally match their source declarations, this file would
    // fail to type-check (and thus fail to run) rather than fail at
    // runtime. Constructing stub implementations here exercises that.
    const confirmationPrompt: IConfirmationPrompt = {
      confirm: async () => true,
    };
    const fixConfirmationPrompt: IFixConfirmationPrompt = {
      confirmFix: async () => true,
    };
    const secretConfirmationPrompt: ISecretConfirmationPrompt = {
      confirmProceedDespiteSecrets: async () => true,
    };
    const readmeConfirmationPrompt: IReadmeConfirmationPrompt = {
      confirmWrite: async () => true,
    };
    const seedPersistenceConsent: ISeedPersistenceConsent = {
      isGranted: async () => true,
    };

    expect(confirmationPrompt).toBeDefined();
    expect(fixConfirmationPrompt).toBeDefined();
    expect(secretConfirmationPrompt).toBeDefined();
    expect(readmeConfirmationPrompt).toBeDefined();
    expect(seedPersistenceConsent).toBeDefined();
  });
});

describe('IFileModificationConfirmation (new capability)', () => {
  class StubFileModificationConfirmation implements IFileModificationConfirmation {
    lastProposal: FileModificationProposal | undefined;
    private readonly result: boolean;

    constructor(result: boolean) {
      this.result = result;
    }

    async confirmModification(proposal: FileModificationProposal): Promise<boolean> {
      this.lastProposal = proposal;
      return this.result;
    }
  }

  function makeProposal(overrides: Partial<FileModificationProposal> = {}): FileModificationProposal {
    return {
      filePath: 'src/example.ts',
      description: 'Actualiza la firma de la función exportada.',
      preview: '- export function foo(a) {}\n+ export function foo(a, b) {}',
      ...overrides,
    };
  }

  it('a stub implementation satisfies the interface and resolves true on confirmation', async () => {
    const stub = new StubFileModificationConfirmation(true);
    const proposal = makeProposal();

    const confirmed = await stub.confirmModification(proposal);

    expect(confirmed).toBe(true);
    expect(stub.lastProposal).toEqual(proposal);
  });

  it('a stub implementation resolves false when the user rejects the proposal', async () => {
    const stub = new StubFileModificationConfirmation(false);
    const proposal = makeProposal({ filePath: 'src/other.ts', description: 'Elimina código muerto.' });

    const confirmed = await stub.confirmModification(proposal);

    expect(confirmed).toBe(false);
    expect(stub.lastProposal?.filePath).toBe('src/other.ts');
  });

  it('VsCodeFileModificationConfirmation is a concrete class implementing the interface', () => {
    const instance = new VsCodeFileModificationConfirmation();
    expect(instance).toBeInstanceOf(VsCodeFileModificationConfirmation);
    expect(typeof instance.confirmModification).toBe('function');
  });
});
