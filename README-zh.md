# dsh-mattpocock-skills

将 [mattpocock/skills][upstream] 中的全部技能（共 38 个）打包为一个 DeepSeek
Harness 插件 bundle。技能正文由**脚本从上游 vendor 而来**，从不手工复制，
因此升级只需重新执行一条命令。

[English](README.md) | **简体中文**

| | |
|---|---|
| 上游仓库 | [github.com/mattpocock/skills][upstream]（MIT） |
| 技能数量 | 38 个，分布在 `engineering`、`productivity`、`misc`、`in-progress` |
| DSH 版本 | `>=0.2.0-rc.1 <0.3.0-0` |
| 运行时依赖 | 无 |

## 谁需要这个包

**你已经用 Codex 插件的形式安装了 Matt Pocock 的技能，而不希望为了让 DSH
看到它们，再往全局 `~/.agents/skills` 里装第二份。**

这正是本包存在的场景。Codex 的插件安装方式是：

```bash
codex plugin marketplace add mattpocock/skills
codex plugin add mattpocock-skills@mattpocock
```

它把技能保存在 Codex 自己的插件存储中，并在启动时自动更新。而 DeepSeek
Harness 会话并不读取那份存储，它只在这些根目录下发现本地技能（这是 provider
的默认值；此外还支持通过 `customSkillDirs` 在项目级与用户级之间插入一个自定义根目录）：

| 优先级 | 根目录 |
|---|---|
| `100` | `<project>/.dsh/skills` |
| `200` | `<project>/.agents/skills` |
| `400` | `~/.dsh/skills` |
| `500` | `~/.agents/skills` |

于是最直接的做法就是把技能复制到 `~/.agents/skills` —— 可以手工复制，也可以用
上游的「复制文件」安装器（`npx skills@latest add mattpocock/skills`）。这确实可行，
DSH 会像对待其他本地技能一样发现它们。但这样一来，同样的 38 个技能就同时存在于
两处，各自有独立的更新路径，只要其中一处被刷新，两者立刻开始不一致。

本包提供了另一种选择：用一个 bundle 通过脚本 vendor 上游内容，让 DSH 获得这些技能，
而无需在任何技能根目录下复制第二份。它不会写入 `~/.agents/skills`、`~/.dsh/skills`
或 `<project>/.agents/skills`。

更具体地说，如果你符合以下情况，这个包也适合你：

- **你希望 agent 配置保持全局、与具体项目无关。** 不需要为每个仓库做初始化，也不把
  `.agents/skills` 提交进各个仓库。
- **你希望技能版本固定、可审计。** `vendor/` 会在 `PROVENANCE.json` 中记录上游的确切
  commit，而不是跟随一个不断变动的全局目录。
- **你希望保留「用户调用 / 模型调用」的区分。** 上游标记为
  `disable-model-invocation` 的那 23 个技能，仍然只能通过 `/名称` 调用。

### 什么情况下你不需要它

如果这些技能已经位于 `~/.agents/skills` 或 `<project>/.agents/skills`，DSH 本来就能
发现它们 —— 再安装本 bundle 不会带来任何额外内容。这些根目录的优先级高于本包
（`500` 和 `200` 对 `600`），因此只要本地已有一份，本包中同名的技能都会被静默遮蔽，
由本地副本胜出。请二者择一，不要同时使用：

- **选择 `~/.agents/skills`**：如果你希望全机器所有 agent 工具共用一份副本，并且愿意
  手工更新、或使用 `npx skills@latest update` 更新。
- **选择本 bundle**：如果你希望 DSH 通过一个带版本、可重新同步的包来获取技能，
  同时 Codex 继续使用它自己的插件管理副本。

## 安装

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-mattpocock-skills
```

`dsh plugin` 会把其余参数转发给 profile 目录内的 `pnpm`，保存该依赖并链接这个包。
随后再启用一次 bundle，它会被写入 `dsh.profile.bundles`：

```bash
# 也可以在 Web 界面中启用：插件 → Bundle → mattpocock-skills
```

安装或替换本包后需要重启 Harness：新的模块代际只在启动时加载。启动后，全部 38 个技能
会出现在会话目录中，可通过 `skill` 工具或 `/名称` 命令调用。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-mattpocock-skills
```

## 跟随上游更新

```bash
node scripts/sync-skills.mjs               # 跟随默认分支
node scripts/sync-skills.mjs --ref v1.3.1  # 固定到某个 tag、分支或 commit
node scripts/sync-skills.mjs --check       # vendor/ 过期时以退出码 1 结束（CI 用）
pnpm sync                                  # 等同第一条命令
```

这是一个零依赖的 Node.js 脚本，凡是有 `node` 和 `git` 的地方都能运行。它会把上游克隆到
临时目录，复制每个技能目录（正文及其 `references/`、`scripts/`、`assets/`、`agents/`
等附属文件），并且只有在暂存副本完整之后才重写 `vendor/mattpocock-skills/` —— 因此运行
中断时，原有目录树仍然可用；即使运行失败，临时目录也会被清理。

它只记录溯源信息 —— 上游仓库、commit、提交日期、版本与技能数量 —— 写入
`vendor/mattpocock-skills/PROVENANCE.json`，整个文件不到 500 字节。技能清单刻意**不**在该
文件中重复：目录树本身就是清单，因此发现逻辑直接读取目录树，两者不会互相矛盾，也不存在
重复推导。

| 参数 / 环境变量 | 含义 |
|---|---|
| `--ref <ref>` | 用指定的 tag、分支或 commit 替代默认分支 |
| `--repo <url>` | 从 fork 而非上游克隆 |
| `--check` | 不写入任何内容；对比暂存的 manifest 与 `vendor/`，不一致时退出码为 1 |
| `MATTPOCOCK_SKILLS_REF` | `--ref` 的默认值 |
| `MATTPOCOCK_SKILLS_REPO` | `--repo` 的默认值 |

退出码：`0` 成功或已是最新，`1` 失败或已过期，`2` 参数错误。
`--check` 是 CI 门禁：它仍会克隆（因此能看到上游的新 commit），但从不写入 `vendor/`。

### 每日自动同步

[`.github/workflows/sync-skills.yml`](.github/workflows/sync-skills.yml) 会**每天
00:00 UTC** 执行一次同步，因此即使是一个从不手动维护的 fork，也能持续跟随上游。

这个任务刻意保持「安静」：它先执行 `--check`，如果上游没有变化，就直接结束、不产生任何
提交；只有上游确实变化时，才执行同步、跑完全部 44 项检查，然后才提交 `vendor/` 并推送 ——
这样一旦上游的 `SKILL.md` 有问题，任务会在检查阶段失败，而不会把坏数据推上分支。

```
检查上游 → （无变化）结束
         → （有变化）同步 → 44 项校验 → 提交 vendor/ → 推送
```

几个值得了解的设计细节：

- **不会产生「只改时间戳」的提交。** 同步按内容摘要比较，并刻意剔除 `syncedAt`，
  因此上游没有变化的那一天不会产生提交。也就是说，`syncedAt` 记录的是内容**最后一次
  变化**的时间，而不是最后一次检查的时间。
- **只提交 `vendor/`。** 任务使用 `git add -- vendor`，因此 runner 中其他位置的意外写入
  不会被一并带上。
- **提交刻意不归属到人。** 提交者为 `github-actions[bot]`；并且用 `GITHUB_TOKEN` 产生的
  提交不会触发其他 workflow —— 这份提交是数据，不是发布。
- **任务串行执行**，由 `concurrency` 分组保证，两次运行不会争抢同一分支。
- **可手动触发**：已开启 `workflow_dispatch`，因此你可以在完全信任定时任务之前，先在
  Actions 页面手动跑一次。

定时工作流只会在默认分支上触发，且 GitHub 的调度是「尽力而为」——请预期有几分钟的偏差，
而不是精确的零点整。如需暂停自动化，在 Actions 页面禁用该 workflow，或删除该文件。

运行中的 Harness 无需重启即可感知重新同步：provider 会监听 vendored 目录，并调用技能
注册表的 `invalidate()`，从而在下一个模型步骤追加一份替换目录。只有 `lib/` 的改动用得着
重启。

## 校验

```bash
node scripts/verify.mjs
```

共 44 项检查，覆盖：frontmatter 解析器；依据 `@deepseek-ai/dsh-skill` 重新表述的候选与
定义校验器；每个 vendored 技能的目录条目与加载出的正文；bundle patch、语言文件与图标；
同步脚本「仅依赖 Node 内置模块」这一约束及其退出码；以及该行的配置 schema。任何一项失败
都会以退出码 1 结束。

## 工作原理

bundle 的 patch 插入一行 Host 插件。该行在 `ctx.skills` 上注册一个**技能 provider** ——
也就是 `dsh-skill-filesystem` 与 `dsh-skill-office` 使用的同一个扩展点 —— 数据来自
vendored 目录树：

```
skills/<bucket>/<name>/SKILL.md     -> 一个目录条目
skills/<bucket>/<name>/references/  -> 该技能的 resource base
```

它不会写入 `.dsh/skills`、`.agents/skills` 或 `~/.dsh/skills`，因此不会与项目自身的技能
冲突，也不需要任何按项目进行的配置。vendored 技能携带优先级 `600`，这是打包类 provider
的标准值，因此项目内同名的本地技能仍然胜出。

frontmatter 由一个小型 YAML 子集解析器（`lib/frontmatter.js`）处理，而不是引入 YAML 库，
从而让本包保持零依赖。它支持普通标量、单引号与双引号标量、`|` 与 `>` 块标量，以及
`metadata.credits` 这类嵌套映射。凡超出该子集的写法 —— flow 集合、锚点、标签 —— 都会
抛错，相应的技能会被跳过并给出警告，而不是静默加载一个被截断的 description。

### 调用策略

上游把 38 个技能中的 23 个标记为 `disable-model-invocation: true`：模型不得自行触达它们，
只能由人输入 `/名称` 调用。provider 将其映射为注册表的
`modelInvocable: false, userInvocable: true`，因此这些技能既不出现在模型的目录中，也不出现
在 `skill` 工具里，但仍可通过 `/ask-matt`、`/setup-matt-pocock-skills` 等命令调用。其余
15 个技能对两种入口都可用。

### 配置

该行无需任何 `config`。以下字段均为可选：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillRoot` | vendored 的 `skills/` 目录树 | 扫描 bucket 子目录的根目录 |
| `provenance` | vendored 的 `PROVENANCE.json` | 来源标注；设为 `false` 可省略 |
| `buckets` | 全部 bucket | 只保留指定 bucket，如 `["engineering"]` |
| `watch` | `true` | `SKILL.md` 变化时重建目录 |

未知字段会被拒绝而非忽略，因此 `skillRoot` 拼错时会明确导致激活失败，而不是悄悄回退到
vendored 目录树。覆盖某个配置行时需重述完整的 `config` 映射，因为匹配到的 patch 覆盖是
整体替换而非合并。

## 包含与不包含的内容

包含：每个 `SKILL.md` 及其附属资源、各 bucket 的 `README.md`、上游的 `LICENSE`、顶层
`README.md`，以及用于溯源的上游 `.claude-plugin/plugin.json`。

不包含：`skills/deprecated/`（只有一个 README，没有技能）、上游的 `.git`、CI 工作流、
`docs/`、`.agents/` 与 `.out-of-scope/` —— 这些是上游贡献者的维护材料，不属于技能本身。

有两个上游技能描述的是本 Harness 并不具备的 Claude Code 专有机制：
`git-guardrails-claude-code` 用于配置 Claude Code hooks，`claude-handoff` 用于把会话交接给
Claude。它们被原样 vendor、也能正常加载，但其指令在此 Harness 中并不适用。

## 目录结构

```
cordis.patch.yml              bundle patch：一行 Host 插件
lib/index.js                  provider：发现、加载、监听
lib/frontmatter.js            SKILL.md frontmatter 的 YAML 子集解析器
lib/config.js                 该行的配置 schema 与校验
locale/{en,zh}.json           插件管理器的展示元数据
icon.svg                      bundle 图标
scripts/sync-skills.mjs        vendor 上游目录树（Node，零依赖）
scripts/verify.mjs            契约校验
.github/workflows/sync-skills.yml  每日上游同步（00:00 UTC）
vendor/mattpocock-skills/     由 sync-skills.mjs 生成 —— 请勿手动修改
```

`vendor/` 是生成目录。修改它会在下次同步时被覆盖；如需修改某个技能，请 fork 上游并把
`MATTPOCOCK_SKILLS_REPO` 指向该 fork。

## 许可

插件代码采用 MIT 许可。vendored 技能为 MIT，版权归 Matt Pocock，上游的 `LICENSE` 随技能
一并保留在 `vendor/mattpocock-skills/LICENSE`。详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

[upstream]: https://github.com/mattpocock/skills
