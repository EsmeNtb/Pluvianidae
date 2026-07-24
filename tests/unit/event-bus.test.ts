import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus';

describe('EventBus', () => {
  it('invokes registered handlers when a matching event is emitted', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('indexing:started', handler);
    bus.emit({ type: 'indexing:started', payload: { totalFiles: 5 } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: 'indexing:started',
      payload: { totalFiles: 5 },
    });
  });

  it('does not invoke handlers registered for a different event type', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('indexing:started', handler);
    bus.emit({
      type: 'indexing:completed',
      payload: { filesIndexed: 1, errors: [] },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls multiple handlers in registration order', () => {
    const bus = new EventBus();
    const calls: string[] = [];

    bus.on('mascot:animate', () => calls.push('first'));
    bus.on('mascot:animate', () => calls.push('second'));
    bus.on('mascot:animate', () => calls.push('third'));

    bus.emit({ type: 'mascot:animate', payload: { type: 'idle' } });

    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('stops calling a handler after its Disposable is disposed', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const subscription = bus.on('indexing:started', handler);
    bus.emit({ type: 'indexing:started', payload: { totalFiles: 1 } });
    subscription.dispose();
    bus.emit({ type: 'indexing:started', payload: { totalFiles: 2 } });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stops calling a handler after off() is called', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('indexing:started', handler);
    bus.off('indexing:started', handler);
    bus.emit({ type: 'indexing:started', payload: { totalFiles: 1 } });

    expect(handler).not.toHaveBeenCalled();
  });

  it('is safe to dispose a subscription more than once', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const subscription = bus.on('indexing:started', handler);
    subscription.dispose();
    expect(() => subscription.dispose()).not.toThrow();
  });
});
