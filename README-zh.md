# dsh-plugin-mattpocock-skills

将 [mattpocock/skills][upstream] 转化为 dsh 插件。

[English](README.md) | **简体中文**

## 项目内容

| | |
|---|---|
| 上游 | [github.com/mattpocock/skills][upstream]（MIT），每日同步 |
| 内容 | 38 个技能，每个一个目录：`skills/<name>/SKILL.md` 及其自带资源 |
| 新增 | 一行 Host 插件，注册 `ctx.skills` provider —— 不写入任何技能根目录 |
| DSH | `>=0.2.0-rc.1 <0.3.0-0` |
| 运行时依赖 | 无 |

上游的 `engineering` / `productivity` / `misc` / `in-progress` 分桶已扁平化去掉：
没有任何东西消费它，且技能名本就跨桶唯一。技能携带优先级 600，因此项目内同名技能仍然胜出。
上游标记 `disable-model-invocation` 的 23 个技能只能通过 `/名称` 调用，模型无法自行触达。
只 vendor `skills/` 与上游 `LICENSE` —— 不含上游的文档、CI 与插件元数据。

## 谁需要它

**你已经用 Codex 插件装过 Matt Pocock 的技能，而不希望为了让 DSH 看到它们，再往
`~/.agents/skills` 里放第二份。**

Codex 的插件方式把技能存在它自己的存储里，Harness 会话读不到。Harness 只从
`<project>/.dsh/skills`、`<project>/.agents/skills`、`~/.dsh/skills`、
`~/.agents/skills` 发现技能。把技能复制进其中一个是可行的，但这会让同样的 38 个技能
存在于两处、各有更新路径，且必然逐渐不一致。

本 bundle 是另一种选择：DSH 无需第二份副本即可获得这些技能。

如果你希望 agent 配置保持全局、与具体项目无关，或希望同步内容版本固定、可审计，它也适合你。

**不需要**的情况：如果技能已在 `~/.agents/skills` 或 `<project>/.agents/skills`，
那些根目录的优先级更高（500/200 对 600），本 bundle 会被静默遮蔽，两者还会互相矛盾。
请二者择一。

## 使用说明

### 安装

从 npm 安装：

```bash
dsh plugin --profile <profile> add dsh-plugin-mattpocock-skills
```

从本地检出安装：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-mattpocock-skills
```

然后启用一次 bundle —— Web 界面 **插件 → Bundle**，或写入 `dsh.profile.bundles` ——
并重启 Harness，因为新的模块代际只在启动时加载。此后全部 38 个技能出现在会话目录中，
可通过 `skill` 工具或 `/名称` 命令调用。

```bash
dsh plugin --profile <profile> remove dsh-plugin-mattpocock-skills   # 卸载
```

### 从上游更新

```bash
node scripts/sync-skills.mjs                # 跟随默认分支
node scripts/sync-skills.mjs --ref v1.3.2   # 固定到某个 tag、分支或 commit
node scripts/sync-skills.mjs --check        # skills/ 过期时以退出码 1 结束
```

零依赖的 Node 脚本：把上游克隆到临时目录，暂存技能目录，仅在副本完整后才替换 `skills/`。
溯源信息 —— 仓库、commit、标识、技能数量 —— 写入 `skills/PROVENANCE.json`。标识跟随上游：
该 commit 恰好带发布 tag 时用 tag，否则用 commit SHA，绝不用我们自行管理的版本号。

运行中的 Harness 无需重启即可感知重新同步；只有 `lib/` 的改动用得着重启。

`.github/workflows/sync-skills.yml` 在 **00:00 UTC** 执行同样的同步，只提交 `skills/`，
且仅在 44 项检查全部通过后才提交 —— 上游没有变化的那天不产生任何提交。

### 校验

```bash
node scripts/verify.mjs
```

44 项检查，覆盖 frontmatter 解析器、注册表校验器、每个技能的目录条目与加载出的正文、
bundle 元数据，以及同步脚本的退出码。

### 发布

按「相对上一个 `v*` tag 的差异」决定版本并发布到 npm：

| 自上个 tag 以来的变化 | 版本 |
|---|---|
| 技能内容 | **patch** |
| 技能增删 | **minor** |
| 插件结构（`cordis.patch.yml`、`lib/`、清单结构） | **major** |

CI 在同步后自动发布 patch 与 minor。**major 永不自动发布** —— 必须手动运行 Release
workflow，因为结构性改动可能让已安装的组合失效。

发布使用 [可信发布（trusted publishing）][trusted]：workflow 用 GitHub OIDC 身份换取短期
npm 凭据，并附上 provenance 证明，因此**仓库中不保存任何 npm token**。需在 npmjs.com
一次性配置 —— 包 → Settings → Trusted Publisher → GitHub Actions，owner 填 `HakurouKen`、
仓库 `dsh-plugin-mattpocock-skills`、workflow 填 `release.yml`，并勾选允许发布。

新包无法使用信任关系，所以**首次发布需手动**：`npm login && npm publish --access public`，
再配置信任关系，并以 `mode: publish-current` 跑一次 workflow 以记录 `v0.1.0` tag。

### 配置

该行无需 `config`。可选字段：`skillRoot`（默认 vendored 的 `skills/`）、`provenance`
（默认其 `PROVENANCE.json`；设为 `false` 可省略）、`watch`（默认 `true`）。未知字段会
明确导致激活失败。

---

插件代码为 MIT。vendored 技能为 MIT，版权归 Matt Pocock，上游许可证位于 `skills/LICENSE`；
详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

[upstream]: https://github.com/mattpocock/skills
[trusted]: https://docs.npmjs.com/trusted-publishers
