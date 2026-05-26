/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     🔄 REPO POOL — Multi-Repo Build Load Balancer           ║
 * ║                                                              ║
 * ║  Jika ada build di repo 1, build selanjutnya otomatis        ║
 * ║  dipindahkan ke repo yang kosong (tidak sedang build).       ║
 * ║                                                              ║
 * ║  Fitur:                                                      ║
 * ║  • Auto-create repo yang belum ada di GitHub                 ║
 * ║  • Auto-push workflow ke semua repo saat startup             ║
 * ║  • Track build per repo (busy / free)                        ║
 * ║  • Fallback ke repo pertama jika semua penuh                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

// Build registry: buildId → { repo, runId, startedAt, status }
const buildRegistry = new Map();

// Repo status: repoName → { busy, buildId, startedAt }
const repoStatus = new Map();

// Timeout: auto-release repo after 35 min (in case build monitoring fails)
const AUTO_RELEASE_MS = 35 * 60 * 1000;

function createRepoPool(config) {
  const { githubOwner, githubToken, repos, autoCreate, workflowYaml } = config;

  const GH_HEADERS = {
    Authorization: `token ${githubToken}`,
    Accept: "application/vnd.github+json",
  };

  // Initialize all repos as free
  for (const repo of repos) {
    if (!repoStatus.has(repo)) {
      repoStatus.set(repo, { busy: false, buildId: null, startedAt: 0 });
    }
  }

  // Auto-release stale repos periodically
  setInterval(() => {
    const now = Date.now();
    for (const [repo, status] of repoStatus.entries()) {
      if (status.busy && status.startedAt && (now - status.startedAt > AUTO_RELEASE_MS)) {
        console.log(`[RepoPool] Auto-release repo ${repo} (stale build ${status.buildId})`);
        releaseRepo(repo);
      }
    }
  }, 60000);

  async function getDefaultBranch(repo) {
    try {
      const { data } = await axios.get(
        `https://api.github.com/repos/${githubOwner}/${repo}`,
        { headers: GH_HEADERS }
      );
      return data.default_branch || "main";
    } catch {
      return "main";
    }
  }

  async function repoExists(repo) {
    try {
      await axios.get(
        `https://api.github.com/repos/${githubOwner}/${repo}`,
        { headers: GH_HEADERS }
      );
      return true;
    } catch (e) {
      return e.response?.status !== 404;
    }
  }

  async function createRepo(repo) {
    try {
      await axios.post(
        "https://api.github.com/user/repos",
        {
          name: repo,
          description: "Flutter Build Bot — Auto-created build repo",
          private: true,
          auto_init: true,
          has_issues: false,
          has_projects: false,
          has_wiki: false,
        },
        { headers: GH_HEADERS }
      );
      console.log(`[RepoPool] ✅ Repo ${repo} berhasil dibuat.`);
      // Give GitHub a moment to initialize
      await new Promise(r => setTimeout(r, 3000));
      return true;
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      if (msg.includes("already exists")) return true;
      console.error(`[RepoPool] ❌ Gagal buat repo ${repo}: ${msg}`);
      return false;
    }
  }

  async function pushWorkflowToRepo(repo) {
    if (!workflowYaml) return { status: "skip", repo };

    const filePath = ".github/workflows/build_apk.yml";
    const branch = await getDefaultBranch(repo);
    const apiUrl = `https://api.github.com/repos/${githubOwner}/${repo}/contents/${filePath}`;

    try {
      let sha;
      let existingContent = "";

      try {
        const res = await axios.get(apiUrl, {
          headers: GH_HEADERS,
          params: { ref: branch },
        });
        sha = res.data.sha;
        existingContent = Buffer.from(res.data.content, "base64").toString("utf8");
      } catch (e) {
        if (e.response?.status !== 404) throw e;
      }

      if (existingContent.trim() === workflowYaml.trim()) {
        return { status: "uptodate", repo, branch };
      }

      await axios.put(apiUrl, {
        message: sha
          ? "bot: update workflow build APK"
          : "bot: auto-setup workflow build APK",
        content: Buffer.from(workflowYaml).toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }, { headers: GH_HEADERS });

      return { status: sha ? "updated" : "created", repo, branch };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      return { status: "error", repo, message: msg, branch };
    }
  }

  async function initAllRepos() {
    const results = [];
    for (const repo of repos) {
      const exists = await repoExists(repo);
      if (!exists && autoCreate) {
        const created = await createRepo(repo);
        if (!created) {
          results.push({ repo, status: "create_failed" });
          continue;
        }
      } else if (!exists) {
        console.warn(`[RepoPool] Repo ${repo} tidak ada dan AUTO_CREATE_REPOS=false`);
        results.push({ repo, status: "not_found" });
        continue;
      }
      const wf = await pushWorkflowToRepo(repo);
      results.push(wf);
    }
    return results;
  }

  function acquireRepo(buildId) {
    // First, try to find a free repo
    for (const repo of repos) {
      const status = repoStatus.get(repo);
      if (status && !status.busy) {
        status.busy = true;
        status.buildId = buildId;
        status.startedAt = Date.now();
        buildRegistry.set(buildId, { repo, startedAt: Date.now(), status: "building" });
        console.log(`[RepoPool] Build ${buildId} → repo ${repo}`);
        return repo;
      }
    }

    // All repos are busy — find the one that's been building the longest (most likely done)
    let oldestRepo = repos[0];
    let oldestTime = Infinity;
    for (const repo of repos) {
      const status = repoStatus.get(repo);
      if (status && status.startedAt < oldestTime) {
        oldestTime = status.startedAt;
        oldestRepo = repo;
      }
    }

    // Force release the oldest and use it
    console.log(`[RepoPool] Semua repo sibuk. Force-release ${oldestRepo} untuk build ${buildId}`);
    const status = repoStatus.get(oldestRepo);
    if (status) {
      status.busy = true;
      status.buildId = buildId;
      status.startedAt = Date.now();
    }
    buildRegistry.set(buildId, { repo: oldestRepo, startedAt: Date.now(), status: "building" });
    return oldestRepo;
  }

  function releaseRepo(repo) {
    const status = repoStatus.get(repo);
    if (status) {
      if (status.buildId) {
        const build = buildRegistry.get(status.buildId);
        if (build) build.status = "done";
      }
      status.busy = false;
      status.buildId = null;
      status.startedAt = 0;
    }
    console.log(`[RepoPool] Repo ${repo} dibebaskan.`);
  }

  function getRepoForBuild(buildId) {
    const entry = buildRegistry.get(buildId);
    return entry ? entry.repo : repos[0];
  }

  function registerBuildRun(buildId, runId) {
    const entry = buildRegistry.get(buildId);
    if (entry) entry.runId = runId;
  }

  function getBuildInfo(buildId) {
    return buildRegistry.get(buildId) || null;
  }

  function getPoolStatus() {
    const result = [];
    for (const repo of repos) {
      const status = repoStatus.get(repo) || { busy: false, buildId: null, startedAt: 0 };
      result.push({
        repo,
        busy: status.busy,
        buildId: status.buildId,
        elapsed: status.startedAt ? Math.floor((Date.now() - status.startedAt) / 1000) : 0,
      });
    }
    return result;
  }

  function getAllRepos() {
    return [...repos];
  }

  return {
    initAllRepos,
    acquireRepo,
    releaseRepo,
    getRepoForBuild,
    registerBuildRun,
    getBuildInfo,
    getPoolStatus,
    getDefaultBranch,
    pushWorkflowToRepo,
    getAllRepos,
    repoExists,
    createRepo,
    GH_HEADERS,
  };
}

module.exports = { createRepoPool, buildRegistry, repoStatus };
