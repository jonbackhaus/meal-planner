import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  TransformersEmbedder,
} from "./embedder.js";

interface FakeOutput {
  data: number[];
}

function makeFakePipeline(vector: number[]) {
  const extractor = vi.fn(
    async (
      _text: string,
      _options: { pooling: string; normalize: boolean },
    ): Promise<FakeOutput> => ({ data: vector }),
  );
  const factory = vi.fn(async (_task: string, _modelId: string) => extractor);
  return { extractor, factory };
}

describe("TransformersEmbedder", () => {
  it("embeds text into the vector produced by the pipeline", async () => {
    const { extractor, factory } = makeFakePipeline([0.1, 0.2, 0.3]);
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    const vector = await embedder.embed("chicken soup");

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(extractor).toHaveBeenCalledWith("chicken soup", {
      pooling: "mean",
      normalize: true,
    });
  });

  it("uses mean pooling and normalization (plumbed through to the pipeline call)", async () => {
    const { extractor, factory } = makeFakePipeline([1, 0, 0]);
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    await embedder.embed("anything");

    expect(extractor.mock.calls[0][1]).toEqual({
      pooling: "mean",
      normalize: true,
    });
  });

  it("lazily loads the pipeline: the factory is not called until the first embed()", async () => {
    const { factory } = makeFakePipeline([1, 2, 3]);
    // biome-ignore lint/correctness/noUnusedVariables: constructing is the point of this assertion
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    expect(factory).not.toHaveBeenCalled();
  });

  it("loads the pipeline only once across multiple embed() calls (memoized)", async () => {
    const { factory } = makeFakePipeline([1, 2, 3]);
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    await embedder.embed("first");
    await embedder.embed("second");

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("passes the feature-extraction task and configured model id to the factory", async () => {
    const { factory } = makeFakePipeline([1, 2, 3]);
    const embedder = new TransformersEmbedder({
      modelId: "Xenova/custom-model",
      pipelineFactory: factory,
    });

    await embedder.embed("text");

    expect(factory).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/custom-model",
    );
  });

  it("defaults to the configured default model id when none is given", async () => {
    const { factory } = makeFakePipeline([1, 2, 3]);
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    await embedder.embed("text");

    expect(factory).toHaveBeenCalledWith(
      "feature-extraction",
      DEFAULT_EMBEDDING_MODEL_ID,
    );
  });

  it("accepts a Float32Array-like `data` output and converts it to a plain number[]", async () => {
    const extractor = vi.fn(async () => ({
      data: new Float32Array([4, 5, 6]),
    }));
    const factory = vi.fn(async () => extractor);
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    const vector = await embedder.embed("text");

    expect(Array.isArray(vector)).toBe(true);
    expect(vector).toEqual([4, 5, 6]);
  });

  it("propagates a rejected pipeline factory (e.g. model load failure)", async () => {
    const factory = vi.fn(async () => {
      throw new Error("model download failed");
    });
    const embedder = new TransformersEmbedder({ pipelineFactory: factory });

    await expect(embedder.embed("text")).rejects.toThrow(
      "model download failed",
    );
  });
});
