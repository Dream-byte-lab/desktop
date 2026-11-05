import { describe, expect, it } from "vitest";
import {
  createAnalysisRunner,
  type AnalysisWorkerLike,
} from "./analysisRunner";
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from "./analysisWorker";

const SR = 22050;

function clickSamples(durationSec: number): Float32Array {
  const buf = new Float32Array(Math.round(durationSec * SR));
  for (let t = 0.25; t < durationSec - 0.05; t += 0.5) {
    const start = Math.round(t * SR);
    for (let i = 0; i < 200 && start + i < buf.length; i += 1) {
      const x = Math.sin(start + i * 12.9898) * 43758.5453;
      buf[start + i] +=
        0.9 * Math.exp(-90 * (i / SR)) * ((x - Math.floor(x)) * 2 - 1);
    }
  }
  return buf;
}

/** A worker the test drives by hand: it never replies on its own. */
class FakeWorker implements AnalysisWorkerLike {
  static last: FakeWorker | null = null;
  sent: AnalysisWorkerRequest[] = [];
  onmessage: ((event: MessageEvent<AnalysisWorkerResponse>) => void) | null =
    null;
  onerror: ((event: { message?: string }) => void) | null = null;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: AnalysisWorkerRequest): void {
    this.sent.push(message);
  }

  terminate(): void {}

  reply(id: number): void {
    this.onmessage?.({
      data: { id, ok: true, read: null },
    } as MessageEvent<AnalysisWorkerResponse>);
  }
}

describe("analysisRunner — inline fallback", () => {
  it("analyses inline when Worker construction fails", async () => {
    const runner = createAnalysisRunner({
      createWorker: () => {
        throw new Error("no workers here");
      },
    });
    const read = await runner.analyse({
      key: "k1",
      samples: clickSamples(8),
      sampleRate: SR,
      depth: "fast",
    });
    expect(read).not.toBeNull();
    expect(Math.abs((read?.bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
    runner.dispose();
  });
});

describe("analysisRunner — hang guard (fix2-0119)", () => {
  it("a worker that never replies settles the request inline instead of pending forever", async () => {
    const runner = createAnalysisRunner({
      createWorker: () => new FakeWorker(),
      timeoutMs: 25,
    });
    // FakeWorker never replies and never errors: before the
    // guard this promise simply never settled, and the session
    // hung on it in its preparing phase.
    const read = await runner.analyse({
      key: "hung",
      samples: clickSamples(8),
      sampleRate: SR,
      depth: "fast",
    });
    // Settled by the inline fallback with the real analysis of
    // the same samples — not lost, not a timeout null.
    expect(read).not.toBeNull();
    expect(Math.abs((read?.bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
    // The request really did go to the worker first.
    expect(FakeWorker.last?.sent).toHaveLength(1);
    runner.dispose();
  });

  it("after a silent death the runner never builds another worker", async () => {
    let workersBuilt = 0;
    const runner = createAnalysisRunner({
      createWorker: () => {
        workersBuilt += 1;
        return new FakeWorker();
      },
      timeoutMs: 25,
    });
    const samples = clickSamples(8);
    await runner.analyse({
      key: "one",
      samples,
      sampleRate: SR,
      depth: "fast",
    });
    const second = await runner.analyse({
      key: "two",
      samples,
      sampleRate: SR,
      depth: "fast",
    });
    // The second request settled inline without a new worker:
    // a silently dead worker is declared dead for good, exactly
    // like one that errored.
    expect(second).not.toBeNull();
    expect(workersBuilt).toBe(1);
    runner.dispose();
  });

  it("a reply inside the budget is untouched by the watchdog", async () => {
    const runner = createAnalysisRunner({
      createWorker: () => new FakeWorker(),
      timeoutMs: 60_000,
    });
    const pending = runner.analyse({
      key: "k",
      samples: clickSamples(2),
      sampleRate: SR,
      depth: "fast",
    });
    const fake = FakeWorker.last;
    fake?.reply(fake.sent[0].id);
    await expect(pending).resolves.toBeNull();
    runner.dispose();
  });
});

describe("analysisRunner — queue discipline", () => {
  it("a later fast request overtakes a queued deep request for a different key", async () => {
    const runner = createAnalysisRunner({
      createWorker: () => new FakeWorker(),
    });
    const samples = clickSamples(2);
    const pA = runner.analyse({
      key: "a",
      samples,
      sampleRate: SR,
      depth: "deep",
    });
    const pB = runner.analyse({
      key: "b",
      samples,
      sampleRate: SR,
      depth: "deep",
    });
    const pC = runner.analyse({
      key: "c",
      samples,
      sampleRate: SR,
      depth: "fast",
    });

    // B was superseded the moment C queued.
    await expect(pB).resolves.toBeNull();

    const fake = FakeWorker.last;
    expect(fake?.sent).toHaveLength(1); // only A in flight
    fake?.reply(fake.sent[0].id);
    await expect(pA).resolves.toBeNull();

    // Next out the door is C (fast), never B.
    expect(fake?.sent).toHaveLength(2);
    expect(fake?.sent[1].depth).toBe("fast");
    fake?.reply(fake.sent[1].id);
    await expect(pC).resolves.toBeNull();
    runner.dispose();
  });

  it("a fast request does NOT supersede a queued deep for the same key", async () => {
    const runner = createAnalysisRunner({
      createWorker: () => new FakeWorker(),
    });
    const samples = clickSamples(2);
    const pA = runner.analyse({
      key: "a",
      samples,
      sampleRate: SR,
      depth: "deep",
    });
    const pDeep = runner.analyse({
      key: "same",
      samples,
      sampleRate: SR,
      depth: "deep",
    });
    const pFast = runner.analyse({
      key: "same",
      samples,
      sampleRate: SR,
      depth: "fast",
    });

    const fake = FakeWorker.last;
    fake?.reply(fake.sent[0].id);
    await pA;
    // Fast jumps the queue…
    expect(fake?.sent[1].depth).toBe("fast");
    fake?.reply(fake.sent[1].id);
    await pFast;
    // …and the same-key deep still runs afterwards.
    expect(fake?.sent).toHaveLength(3);
    expect(fake?.sent[2].depth).toBe("deep");
    fake?.reply(fake.sent[2].id);
    await expect(pDeep).resolves.toBeNull();
    runner.dispose();
  });
});
