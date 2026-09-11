"""Unit tests for the memory MCP server.

Covers SPEC: .scratch/memory-upgrade/SPEC.md (MT-T1 .. MT-T6).
Run from extensions/memory:
    python -m unittest discover -s tests -v
"""

import contextlib
import os
import sqlite3
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MEMDIR = os.path.dirname(_HERE)
if _MEMDIR not in sys.path:
    sys.path.insert(0, _MEMDIR)

import tokenizer
from store import MemoryStore

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _disabled_jieba():
    """Force the bigram fallback path for the duration of the block."""
    saved = (tokenizer._jieba, tokenizer._load_attempted)
    tokenizer._jieba = None
    tokenizer._load_attempted = True
    try:
        yield
    finally:
        tokenizer._jieba, tokenizer._load_attempted = saved


def _tmp_db_path() -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return path


V2_SCHEMA_SQL = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE memories (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL CHECK(type IN ('fact','experience','lesson')),
    scope        TEXT NOT NULL DEFAULT 'global',
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    embedding    BLOB,
    importance   REAL NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    content_hash TEXT
);
CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (memory_id, tag_id)
);
CREATE TABLE associations (
    source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    weight     REAL NOT NULL DEFAULT 0.5,
    type       TEXT NOT NULL DEFAULT 'related_to'
               CHECK(type IN ('related_to','derived_from','contradicts','supports')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id, type)
);
CREATE TABLE content_refs (
    source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, target_id)
);
INSERT INTO meta VALUES ('schema_version', '2');
"""

MEM_A = "11111111-1111-1111-1111-111111111111"
MEM_B = "22222222-2222-2222-2222-222222222222"


def _make_v2_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(V2_SCHEMA_SQL)
    conn.execute(
        "INSERT INTO memories (id,type,scope,title,content,importance,access_count,"
        "created_at,updated_at,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (MEM_A, "fact", "global", "人工智能入门",
         "关于机器学习与人工智能的笔记，包含神经网络基础。", 0.5, 0,
         "2026-01-01T00:00:00", "2026-01-01T00:00:00", "hash-a"),
    )
    conn.execute(
        "INSERT INTO memories (id,type,scope,title,content,importance,access_count,"
        "created_at,updated_at,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (MEM_B, "lesson", "project:demo", "部署踩坑",
         "Docker 部署时端口冲突导致启动失败，需要检查端口占用。", 0.8, 0,
         "2026-01-02T00:00:00", "2026-01-02T00:00:00", "hash-b"),
    )
    conn.commit()
    conn.close()


def _new_store() -> tuple[MemoryStore, str]:
    path = _tmp_db_path()
    return MemoryStore(path), path


def _memories_from(result) -> list[dict]:
    """Accept either the legacy bare list or the new {results: [...]} shape."""
    if isinstance(result, dict):
        return result.get("results", [])
    return result


# ---------------------------------------------------------------------------
# MT-T1: tokenizer
# ---------------------------------------------------------------------------


class TestTokenizer(unittest.TestCase):
    def test_index_expands_subwords(self):
        tokens = tokenizer.tokenize_for_index("人工智能的分支").split()
        self.assertIn("智能", tokens)      # cut_for_search subword
        self.assertIn("人工智能", tokens)  # whole word

    def test_index_bigram_fallback(self):
        with _disabled_jieba():
            tokens = tokenizer.tokenize_for_index("人工智能").split()
        self.assertIn("智能", tokens)
        self.assertIn("人工", tokens)

    def test_query_or_semantics_and_quotes(self):
        q = tokenizer.build_fts_query("用户喜欢编程")
        self.assertIn(" OR ", q)
        self.assertIn('"编程"', q)

    def test_query_filters_stopwords(self):
        q = tokenizer.build_fts_query("我的记忆")
        self.assertNotIn('"的"', q)

    def test_query_strips_punctuation(self):
        q = tokenizer.build_fts_query("hello, world!!")
        self.assertNotIn(",", q)
        self.assertNotIn("!", q)
        self.assertIn('"hello"', q.lower())

    def test_query_escapes_quotes(self):
        q = tokenizer.build_fts_query('say "hi"')
        # inner double quotes must not break the FTS phrase syntax
        self.assertEqual(q.count('"') % 2, 0)

    def test_status_reports_engine(self):
        self.assertIn(tokenizer.get_tokenizer_status(), ("jieba", "bigram"))

    def test_empty_query_returns_empty_string(self):
        self.assertEqual(tokenizer.build_fts_query("   "), "")


# ---------------------------------------------------------------------------
# MT-T1: schema v3 migration
# ---------------------------------------------------------------------------


class TestSchemaMigration(unittest.TestCase):
    def setUp(self):
        self.path = _tmp_db_path()
        _make_v2_db(self.path)

    def tearDown(self):
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def test_migration_adds_v3_columns(self):
        store = MemoryStore(self.path)
        cols = {r[1] for r in store._conn.execute("PRAGMA table_info(memories)")}
        for c in ("version", "superseded_by", "deleted_at", "source"):
            self.assertIn(c, cols)
        self.assertEqual(store.get_meta("schema_version"), "3")
        store.close()

    def test_migration_preserves_data(self):
        store = MemoryStore(self.path)
        self.assertEqual(store.get_stats()["total_memories"], 2)
        mem = store.get_memory(MEM_A)
        self.assertEqual(mem["title"], "人工智能入门")
        self.assertEqual(mem["version"], 1)
        store.close()

    def test_migration_rebuilds_fts(self):
        store = MemoryStore(self.path)
        self.assertTrue(store.get_capabilities()["fts"])
        hits = store.fts_search("智能", limit=5)
        self.assertTrue(hits)
        self.assertEqual(hits[0]["id"], MEM_A)
        store.close()

    def test_migration_is_idempotent(self):
        store = MemoryStore(self.path)
        store.close()
        store2 = MemoryStore(self.path)  # second open must not re-migrate or crash
        self.assertEqual(store2.get_stats()["total_memories"], 2)
        hits = store2.fts_search("端口冲突", limit=5)
        self.assertEqual(hits[0]["id"], MEM_B)
        store2.close()

    def test_concurrent_migration(self):
        """server.py + api.py open the same v2 DB simultaneously (deployment
        scenario): exactly one migrates, the other must not crash with
        'duplicate column name'."""
        import threading

        results: list[tuple[str, object]] = []
        barrier = threading.Barrier(2)

        def open_store() -> None:
            barrier.wait()  # maximize the overlap
            try:
                s = MemoryStore(self.path)
                results.append(("ok", s.get_stats()["total_memories"]))
                s.close()
            except Exception as exc:  # noqa: BLE001 — the assertion reports it
                results.append(("err", str(exc)))

        threads = [threading.Thread(target=open_store) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)

        self.assertEqual(len(results), 2)
        for status, detail in results:
            self.assertEqual(status, "ok", f"concurrent open failed: {detail}")
        self.assertEqual(results[0][1], 2)  # data intact in both


# ---------------------------------------------------------------------------
# MT-T2: FTS retrieval channel
# ---------------------------------------------------------------------------


class TestFtsSearch(unittest.TestCase):
    def setUp(self):
        self.store, self.path = _new_store()
        self.store.add_memory("fact", "人工智能入门", "机器学习与神经网络的基础笔记。")
        self.store.add_memory("lesson", "Docker 端口冲突", "容器启动失败，原因是端口被占用。")
        self.store.add_memory("experience", "Python 虚拟环境", "使用 venv 隔离依赖。")

    def tearDown(self):
        self.store.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def test_chinese_subword_hit(self):
        hits = self.store.fts_search("智能", limit=5)
        self.assertTrue(hits)
        self.assertEqual(hits[0]["title"], "人工智能入门")

    def test_title_weight_ranks_higher(self):
        # same term in title vs content only — the title match must rank first
        self.store.add_memory("fact", "KafkaX 组件说明", "与检索无关的内容。")
        self.store.add_memory("fact", "无关标题内容", "正文提到 KafkaX 一次。")
        hits = self.store.fts_search("KafkaX", limit=10)
        self.assertEqual(hits[0]["title"], "KafkaX 组件说明")

    def test_no_match_returns_empty(self):
        self.assertEqual(self.store.fts_search("量子力学", limit=5), [])

    def test_scope_filter(self):
        hits = self.store.fts_search("端口", scope=["project:demo"], limit=5)
        self.assertEqual(hits, [])

    def test_index_sync_on_update(self):
        mem = self.store.add_memory("fact", "临时标题", "里面有龙猫这个词。")
        self.assertTrue(self.store.fts_search("龙猫", limit=5))
        self.store.update_memory(mem["id"], title="新标题", content="改成别的内容了。")
        self.assertEqual(self.store.fts_search("龙猫", limit=5), [])
        self.assertTrue(self.store.fts_search("别的内容", limit=5))

    def test_index_sync_on_delete(self):
        mem = self.store.add_memory("fact", "待删除", "独特词汇火星车。")
        self.assertTrue(self.store.fts_search("火星车", limit=5))
        self.store.delete_memory(mem["id"])
        self.assertEqual(self.store.fts_search("火星车", limit=5), [])

    def test_score_in_unit_range(self):
        hits = self.store.fts_search("人工智能", limit=5)
        self.assertTrue(0.0 < hits[0]["score"] < 1.0)


# ---------------------------------------------------------------------------
# MT-T3: RRF fusion + strategy
# ---------------------------------------------------------------------------


class TestHybridSearch(unittest.TestCase):
    def setUp(self):
        from search_engine import hybrid_search

        self.hybrid_search = hybrid_search
        self.store, self.path = _new_store()
        self.store.add_memory("fact", "人工智能基础", "神经网络与深度学习。", tags=["ml", "ai"])
        self.store.add_memory("lesson", "Docker 部署", "端口冲突排查。", tags=["docker", "部署"])

    def tearDown(self):
        self.store.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def test_rrf_merge_rank_reward(self):
        from search_engine import rrf_merge

        lists = [[{"id": "a"}, {"id": "b"}], [{"id": "b"}, {"id": "c"}]]
        merged = rrf_merge(lists, key=lambda m: m["id"])
        self.assertEqual(merged[0]["id"], "b")  # present in both lists wins
        self.assertGreater(merged[0]["rrf_score"], merged[1]["rrf_score"])

    def test_strategy_reported(self):
        result = self.hybrid_search(self.store, "人工智能", mode="hybrid", limit=5)
        self.assertIn(result["strategy"], ("fts", "hybrid", "tag", "like"))
        self.assertIn("results", result)

    def test_semantic_mode_reports_unavailable(self):
        """Regression: semantic mode must NOT silently return an empty list."""
        result = self.hybrid_search(self.store, "人工智能", mode="semantic", limit=5)
        self.assertEqual(result["strategy"], "none")
        self.assertTrue(result.get("message"))
        self.assertEqual(result["results"], [])

    def test_hybrid_finds_by_keyword(self):
        result = self.hybrid_search(self.store, "端口冲突", mode="hybrid", limit=5)
        results = _memories_from(result)
        self.assertTrue(results)
        self.assertEqual(results[0]["title"], "Docker 部署")

    def test_small_corpus_threshold_exemption(self):
        """Fewer hits than limit: absolute BM25 threshold must not wipe them out."""
        result = self.hybrid_search(self.store, "神经网络 深度学习", mode="hybrid",
                                    limit=10, min_similarity=0.99)
        self.assertTrue(_memories_from(result))

    def test_threshold_applies_when_many_candidates(self):
        """With more candidates than limit, weak scores are filtered out."""
        from search_engine import _apply_threshold

        weak = [{"id": str(i), "score": 0.05} for i in range(30)]
        strong = [{"id": "s1", "score": 0.9}, {"id": "s2", "score": 0.8}]
        kept = _apply_threshold(weak + strong, limit=10, min_similarity=0.3)
        self.assertEqual({h["id"] for h in kept}, {"s1", "s2"})


# ---------------------------------------------------------------------------
# MT-T5: two-phase store contract + quality gate
# ---------------------------------------------------------------------------


class TestStoreContract(unittest.TestCase):
    def setUp(self):
        self.store, self.path = _new_store()

    def tearDown(self):
        self.store.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def _handle(self, arguments: dict) -> dict:
        import asyncio
        import json

        import server as server_mod

        server_mod.store = self.store
        out = asyncio.run(server_mod._handle_memory_store(arguments))
        return json.loads(out[0].text)

    def test_fresh_store_direct(self):
        res = self._handle({"type": "fact", "title": "全新主题", "content": "量子计算的基本概念介绍。"})
        self.assertEqual(res["status"], "stored")

    def test_conflict_detected_does_not_persist(self):
        self._handle({"type": "fact", "title": "人工智能入门", "content": "机器学习与神经网络的笔记。"})
        before = self.store.get_stats()["total_memories"]
        res = self._handle({"type": "fact", "title": "人工智能进阶", "content": "机器学习与神经网络的深入笔记。"})
        self.assertEqual(res["status"], "conflict_detected")
        self.assertTrue(res["candidates"])
        self.assertEqual(self.store.get_stats()["total_memories"], before)  # NOT persisted

    def test_action_merge_supersedes_targets(self):
        first = self._handle({"type": "fact", "title": "人工智能入门", "content": "机器学习与神经网络的笔记。"})
        res = self._handle({
            "type": "fact", "title": "人工智能入门", "content": "机器学习与神经网络的笔记。",
            "action": "merge", "target_ids": [first["id"]],
            "merged_content": "机器学习、神经网络与深度学习的完整笔记。",
        })
        self.assertEqual(res["status"], "merged")
        self.assertIn(first["id"], res["superseded"])
        # superseded target must be invisible to search
        found = self.store.fts_search("机器学习", limit=10)
        ids = [h["id"] for h in found]
        self.assertNotIn(first["id"], ids)
        self.assertIn(res["id"], ids)

    def test_action_skip_persists_nothing(self):
        before = self.store.get_stats()["total_memories"]
        res = self._handle({
            "type": "fact", "title": "任意", "content": "任意内容文本。",
            "action": "skip",
        })
        self.assertEqual(res["status"], "skipped")
        self.assertEqual(self.store.get_stats()["total_memories"], before)

    def test_invalid_action_rejected(self):
        res = self._handle({"type": "fact", "title": "t", "content": "一些足够长的内容文本。",
                            "action": "explode"})
        self.assertEqual(res["status"], "rejected")
        self.assertEqual(res["reason"], "invalid_action")

    def test_missing_target_rejected(self):
        res = self._handle({"type": "fact", "title": "t", "content": "一些足够长的内容文本。",
                            "action": "update", "target_ids": ["nonexistent-id"]})
        self.assertEqual(res["status"], "rejected")
        self.assertEqual(res["reason"], "target_not_found")

    def test_gate_too_short(self):
        res = self._handle({"type": "fact", "title": "t", "content": "短"})
        self.assertEqual(res["status"], "rejected")
        self.assertEqual(res["reason"], "too_short")

    def test_gate_noise(self):
        res = self._handle({"type": "fact", "title": "t", "content": "？？？？？？？？？？？？"})
        self.assertEqual(res["status"], "rejected")
        self.assertEqual(res["reason"], "noise")

    def test_gate_empty(self):
        res = self._handle({"type": "fact", "title": "t", "content": "   "})
        self.assertEqual(res["status"], "rejected")
        self.assertEqual(res["reason"], "empty_content")

    def test_gate_too_long(self):
        res = self._handle({"type": "fact", "title": "t", "content": "长" * 8001})
        self.assertEqual(res["status"], "rejected")
        self.assertEqual(res["reason"], "too_long")

    def test_source_recorded(self):
        res = self._handle({"type": "fact", "title": "来源测试", "content": "记录来源字段的内容文本。",
                            "source": "session-42"})
        mem = self.store.get_memory(res["id"])
        self.assertEqual(mem["source"], "session-42")


# ---------------------------------------------------------------------------
# MT-T6: soft delete + version + merge graph transfer
# ---------------------------------------------------------------------------


class TestLifecycle(unittest.TestCase):
    def setUp(self):
        self.store, self.path = _new_store()
        self.a = self.store.add_memory("fact", "记忆 A", "关于苹果的内容。")
        self.b = self.store.add_memory("fact", "记忆 B", "关于香蕉的内容。")
        self.store.add_association(self.a["id"], self.b["id"], weight=0.8, type="related_to")

    def tearDown(self):
        self.store.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def test_version_increments_on_update(self):
        self.assertEqual(self.store.get_memory(self.a["id"])["version"], 1)
        self.store.update_memory(self.a["id"], content="苹果的新内容。")
        self.assertEqual(self.store.get_memory(self.a["id"])["version"], 2)

    def test_soft_delete_hides_from_search_but_get_works(self):
        self.store.soft_delete_memory(self.a["id"])
        self.assertEqual(self.store.fts_search("苹果", limit=5), [])
        self.assertIsNotNone(self.store.get_memory(self.a["id"]))
        self.assertIsNotNone(self.store.get_memory(self.a["id"])["deleted_at"])

    def test_hard_delete_removes_row(self):
        import asyncio
        import json

        import server as server_mod

        server_mod.store = self.store
        out = asyncio.run(server_mod._handle_memory_forget(
            {"id": self.a["id"], "confirm": True, "hard": True}))
        res = json.loads(out[0].text)
        self.assertEqual(res["status"], "forgotten")
        self.assertFalse(res["soft"])
        self.assertIsNone(self.store.get_memory(self.a["id"]))

    def test_merge_transfers_associations(self):
        new_id = self.store.merge_supersede(
            target_ids=[self.a["id"]],
            type="fact", title="合并记忆", content="苹果与香蕉的合并内容。",
        )
        # the association a→b must move to the new record
        assocs = self.store.get_associations(new_id, direction="outgoing")
        self.assertTrue(any(x["target_id"] == self.b["id"] for x in assocs))
        # old record superseded and invisible
        old = self.store.get_memory(self.a["id"])
        self.assertEqual(old["superseded_by"], new_id)

    def test_merge_importance_takes_max(self):
        """A merge is never less important than its most important part,
        even when the caller passes a lower importance explicitly."""
        self.store.update_memory(self.b["id"], importance=0.9)
        new_id = self.store.merge_supersede(
            target_ids=[self.a["id"], self.b["id"]],
            type="fact", title="合并", content="合并内容文本。",
            importance=0.2,  # caller underestimates
        )
        self.assertEqual(self.store.get_memory(new_id)["importance"], 0.9)

    def test_merge_unknown_target_raises_and_writes_nothing(self):
        before = self.store.get_stats()["total_memories"]
        with self.assertRaises(ValueError):
            self.store.merge_supersede(
                target_ids=[self.a["id"], "nonexistent-id"],
                type="fact", title="合并", content="合并内容文本。",
            )
        self.assertEqual(self.store.get_stats()["total_memories"], before)  # no orphan record
        self.assertIsNone(self.store.get_memory(self.a["id"])["superseded_by"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
