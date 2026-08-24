"""Embedding model adapter — lightweight, no PyTorch.

When a local model is not available, encode() raises NotImplementedError.
cosine_similarity() uses pure Python (no numpy) so pre-computed vectors
(e.g. from an external embedding API) can still be compared.

Tag clustering is NOT performed locally — use the `memory_normalize_tags`
MCP tool to let an external LLM handle grouping instead.
"""

from __future__ import annotations

import math
from typing import Optional


class EmbeddingModel:
    """Lightweight embedder — no local model loaded by default."""

    MODEL_NAME = "none"
    DIM = 0

    def __init__(self, model_path: Optional[str] = None) -> None:
        self._model_path = model_path
        self._loaded = False

        # Try to load a local model if a path was provided
        if model_path:
            try:
                self._try_load_local(model_path)
            except Exception:
                pass

    def _try_load_local(self, path: str) -> None:
        """Attempt to load a local sentence-transformers model."""
        from sentence_transformers import SentenceTransformer
        import os
        local = os.environ.get("EMBEDDING_MODEL_PATH", path)
        if local and os.path.isdir(local):
            self._model = SentenceTransformer(local)
            self._loaded = True
            # Sniff dimensions from a test encoding
            import numpy as np
            v = self._model.encode("test", convert_to_numpy=True)
            self.MODEL_NAME = os.path.basename(local)
            self.DIM = int(v.shape[0])

    @property
    def model(self) -> object:
        if not self._loaded:
            raise NotImplementedError(
                "No local embedding model is loaded. "
                "Install sentence-transformers and provide EMBEDDING_MODEL_PATH, "
                "or use an external embedding API."
            )
        return self._model

    @property
    def loaded(self) -> bool:
        return self._loaded

    def encode(self, text: str) -> list[float]:
        """Encode a single text. Raises NotImplementedError if no local model."""
        if not self._loaded:
            raise NotImplementedError("No local embedding model available")
        import numpy as np
        vec = self._model.encode(text, convert_to_numpy=True)
        return vec.astype(np.float32).tolist()

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        """Encode multiple texts. Raises NotImplementedError if no local model."""
        if not self._loaded:
            raise NotImplementedError("No local embedding model available")
        import numpy as np
        vecs = self._model.encode(texts, convert_to_numpy=True)
        return vecs.astype(np.float32).tolist()

    # -- Pure-Python similarity (no numpy) -----------------------------------

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        """Cosine similarity between two vectors (pure Python)."""
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a < 1e-10 or norm_b < 1e-10:
            return 0.0
        return dot / (norm_a * norm_b)

    @staticmethod
    def batch_similarity(query: list[float], matrix: list[list[float]]) -> list[float]:
        """Cosine similarity between query vector and a matrix (pure Python)."""
        norm_q = math.sqrt(sum(x * x for x in query))
        if norm_q < 1e-10:
            return [0.0] * len(matrix)
        q_norm = [x / norm_q for x in query]
        scores = []
        for row in matrix:
            dot = sum(x * y for x, y in zip(q_norm, row))
            norm_r = math.sqrt(sum(x * x for x in row))
            if norm_r < 1e-10:
                scores.append(0.0)
            else:
                scores.append(dot / norm_r)
        return scores

    def model_info(self) -> dict[str, str]:
        return {"name": self.MODEL_NAME, "dim": str(self.DIM)}
