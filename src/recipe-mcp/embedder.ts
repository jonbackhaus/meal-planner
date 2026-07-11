/**
 * Local, in-process embedder for the recipe MCP server's vector index.
 *
 * Ratified stack: `@huggingface/transformers` (transformers.js) running a
 * local sentence-embedding model — no cloud embedding API. The model is
 * lazy-loaded (first call to `embed()`), and its id is configurable.
 */

/** Minimal embedding interface consumed by sync.ts / vector-store.ts callers. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Shape of transformers.js's feature-extraction pipeline output we rely on. */
interface FeatureExtractionOutput {
  data: ArrayLike<number>;
}

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

/**
 * Factory for the transformers.js pipeline, injectable so tests never
 * download a real model. Mirrors `transformers.pipeline("feature-extraction", modelId)`.
 */
export type PipelineFactory = (
  task: "feature-extraction",
  modelId: string,
) => Promise<FeatureExtractionPipeline>;

async function defaultPipelineFactory(
  task: "feature-extraction",
  modelId: string,
): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline(task, modelId);
  return extractor as unknown as FeatureExtractionPipeline;
}

export interface TransformersEmbedderOptions {
  /** transformers.js model id. Default: Xenova/all-MiniLM-L6-v2. */
  modelId?: string;
  /** Injectable pipeline factory (tests supply a fake; production uses transformers.js). */
  pipelineFactory?: PipelineFactory;
}

/**
 * `Embedder` backed by a local transformers.js feature-extraction pipeline.
 * Produces a mean-pooled, L2-normalized sentence embedding. The pipeline is
 * lazily created on the first `embed()` call and memoized thereafter.
 */
export class TransformersEmbedder implements Embedder {
  private readonly modelId: string;
  private readonly pipelineFactory: PipelineFactory;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(options: TransformersEmbedderOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
    this.pipelineFactory = options.pipelineFactory ?? defaultPipelineFactory;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.pipelineFactory(
        "feature-extraction",
        this.modelId,
      );
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = await this.getPipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }
}
