# Gal Advisor for OpenCode 1.18.31

証拠の増えない反復を止め、独立した診断と「次の1操作」の契約で復帰するハーネスです。
Qwenを主エージェントとして使う場合を想定していますが、主モデルは固定しません。

## 構成

- `AGENTS.md`: 主エージェント向けの検知・引き継ぎ・復帰ルール。グローバル用の追記にも使えます。
- `.opencode/agents/gal-advisor.md`: fresh contextで動く診断subagent。`steps: 5`、読み取り専用。
- `.opencode/plugins/gal-loop-guard.ts`: **V1 API**による実行前ロック、相談制限、復帰ツール。
- `.opencode/gal/guard.ts`: 検知と状態遷移。プラグインと一緒にコピーしてください。

## 導入

まず軽量版なら、対象プロジェクトに `gal-advisor.md` を同じ相対パスでコピーし、
既存 `AGENTS.md` の末尾に本リポジトリの `AGENTS.md` を追記します。
既存の指示を置き換えないでください。この方式の停止・回数管理はモデルの協力に依存します。

強制ガードも使う場合は `.opencode/plugins/gal-loop-guard.ts` と
`.opencode/gal/guard.ts` を同じ構造でコピーし、対象の `.opencode/package.json` の
dependenciesへ `"@opencode-ai/plugin": "1.18.31"` を追加します。
このプロジェクト自身にはすべて配置済みです。OpenCodeを再起動すると読み込まれます。

全プロジェクトで使う場合の配置先:

```text
~/.config/opencode/AGENTS.md                  ← 追記
~/.config/opencode/agents/gal-advisor.md
~/.config/opencode/plugins/gal-loop-guard.ts
~/.config/opencode/gal/guard.ts
~/.config/opencode/package.json              ← dependenciesをマージ
```

グローバルとプロジェクトの両方へ同じプラグインを配置しないでください。
ユーザーのグローバル設定は本リポジトリの作成時には変更していません。

Advisorを別モデルにするには、そのfrontmatterへ利用可能な
`model: provider/model-id` を追加します。省略時は親モデルを継承します。
APIキーや架空のモデルIDは同梱しません。

## 動作

```text
RUNNING → REQUIRED → CONSULTING → CONTRACT → NEXT → NEXT_EXECUTING → RUNNING
                     └─ 予算切れ・重複相談・診断失敗 → EXHAUSTED
                                                └─ hook/infra失敗 → REPAIR → NEXT
```

停止中は、`gal_status`、許可された段階の制御ツール、Advisorへの `task`、
契約したNEXT以外のツール呼び出しを拒否します。bashや別subagentによる迂回も拒否します。
すでに実行中の操作を巻き戻す機能はありません。

1. 人間が `gal_report` を指示する必要はありません。主エージェントはread/glob/grep、`openspec list/status/show/instructions`、`openspec store list`、read-only Git確認で作業内容を理解できますが、
   goal未登録のまま最初のedit/write/patchまたはその他のbash検証へ進むとGuardが `GAL GOAL REQUIRED` でその1操作を止めます。
   主エージェント自身が `gal_report(goal=...)` で現在タスクを短く登録すると、そのままRUNNINGで再開できます。
   `gal_status` は既定でcompact表示（phase/reason/契約状態/current evidence summary/metrics）だけを返します。
   永続state全体が明示的に必要な診断時だけ `gal_status` の `raw: true` を使用してください。
2. Guardが停止したら `task` の `subagent_type: gal-advisor` を呼びます。
   プラグインはプロンプトを診断パケットに置換し、`task_id` を取り除いてfresh contextを確保します。
3. Advisorは6セクション、NEXT MOVEには `{"tool":"...","args":{...}}` を1個返します。
4. 主エージェントはdecision別ツールを使います。
   `gal_accept(reason,evidence)` はAdvisorのNEXTをそのまま採用し、置換moveを入力できません。
   `gal_reject(reason,evidence,next_tool,next_args)` は客観的根拠と、Advisorとは異なる有効な観測を必須にします。
   `gal_repair` はNEXT_EXECUTINGで、正しい契約toolがtool/schema/infrastructure errorを返したのにcompletion hookだけ観測できなかった場合専用です。
5. 指定した1操作はまず `NEXT_EXECUTING` に入り、その結果をGuardが観測してから通常作業へ戻ります。
   正常に観測するとtool出力へ `GAL RECOVERY COMPLETE ... phase=RUNNING` を追記します。
   NEXTのtool/argsが契約と違う場合、そのtoolは実行せず `phase_after=CONTRACT / move_cleared=true / REPAIR=false` を明示して戻します。
6. 認識済みverificationがPASSし、OpenSpecの `tasks.md` で現在タスクが `[ ] → [x]` になるとverified completion checkpointを記録します。
   以後はread/grep/glob、read-only Git/OpenSpec discovery、認識済みverificationだけを許可し、edit/write/patchとad-hoc bashを停止します。
   本物の欠陥を新たに見つけた場合はcheckpoint後のevidence IDを集め、`gal_reopen(reason,evidence)` で明示的に再開します。reopenで許可される訂正editは1回だけで、その後は認識済みverificationが必須です。PASSならcheckpointを再設定し、FAILならcheckpointを解除して通常デバッグへ戻します。

同じ問題の相談は最大2回です。問題キーは現在のfailure種別・診断・ファイル・位置から作り、独立したfailureへ変わると新しいepisodeと相談予算になります。
同じ問題で前回と観測証拠が同じなら再相談を拒否しEXHAUSTEDにします。
再読み込み・コンパクションで予算を忘れないよう、プロジェクトの `.gal-state/` にセッション別状態を保存します。
stateにはschema versionを持たせます。versionなしの旧stateを読み込んだ場合は一度だけ安全migrationを行い、
phase/problem/契約/相談予算/loop counterを新規セッション相当にリセットします。旧evidenceはraw履歴として最大24件保持しますが、
`episodeStartTick` を履歴の次へ進めるためcurrent evidenceや新しい契約の根拠には使用されません。
EXHAUSTEDからモデル自身が解除するツールはありません。ユーザーへ事実と判断待ち事項を報告させます。
ユーザーが問題を整理して新しいセッションを開始すると新しい予算になります。

## 検知範囲と限界

| 条件 | 実装 |
|---|---|
| 同じtool/inputの失敗2回 | 自動。例外はtool errorイベント、bashは終了コード・一般的なエラー表記を利用 |
| 同じfailureが修正後も継続 | 自動。failure種別・診断・ファイル・約10行単位の位置・コマンドfamilyで比較。コード検証failureだけを修正回数判定に使う |
| 編集3回で進展なし | 自動。failureで示されたファイルに関係するedit/write/patchだけを集計。無関係な編集は修正回数に含めない |
| CLI/host shellの取り違え | `unknown option` やPowerShell上のPOSIXコマンド不整合を分類し、ソース編集ではなくコマンド修正を促すNOTEを返す |
| 同じ検索3回、結果不変 | 自動。glob/grepの完全一致ベース |
| 調査停滞 / information-gain loop | goal登録後、同一subjectのread/grep/glob/bash観測を比較。readは対象ファイル、globはpath+pattern、grepはpath+include+patternをsubject化し、行番号・数値・timing・ID揺らぎを正規化。通常は直近6ツール内3 stale、verified completion後は直近4ツール内2 staleでAdvisor相談を要求 |
| テスト失敗数の減少・エラー種別/ファイルの変化 | カウンターをリセット。Node TAPと一般的なTests表記に対応 |
| 否定済み仮説の再採用 | 同じ仮説キーのgal_reportで検知。証拠ID必須 |
| 機械検証の手作業化・baseline矛盾 | 主エージェントのgal_reportで即停止 |
| SOFTシグナル | gal_reportの異なる2種類、直近8ツール以内 |
| Goal未登録の実作業 | read/glob/grep、OpenSpec/Gitのread-only discovery（openspec store listを含む）は許可。最初のedit/write/patchまたはそれ以外のbashをGAL GOAL REQUIREDで停止し、gal_report(goal=...)を要求 |
| 成功後の再オープン | 認識済みverification PASS + OpenSpec task [x] でcompletion checkpoint。edit/write/patchとad-hoc bashを停止。新しいevidence + gal_reopenで訂正editを1回だけ許可し、その後verification必須。PASSで再ロック、FAILで自動解除 |
| Advisorの観測回数 | プラグイン有効時はread/glob/grepを合計2回まで |

自由な自然言語の意味判定、隠れた思考、同義検索、任意言語のテスト出力、
bash内のファイル編集、変更の往復を完全に自動検出するものではありません。investigation stallは意味理解ではなく、同一subjectの正規化output fingerprintに基づく保守的な近似です。
特に「HEADも壊れていたのでは」という自由文だけを確実に捕捉するとは主張しません。
仮説報告の協力部分と機械的な停止部分を分けてあります。

問題キーはfailure種別・正規化した診断・ファイル・位置のepisode signatureを基準にします。
同じ問題でコマンドを言い換えて相談予算を迂回しにくくしつつ、明確に異なるfailureは別episodeとして扱います。
Guardの停止メッセージはraw evidenceを含まないcompact stateだけを返します。Advisorへ渡す診断packetだけがevidence本文を含み、
最大12件・各1200文字に制限します。これにより停止エラーやsystem injectionが巨大化して後続toolのJSON上限を圧迫しにくくします。
証拠パケットも現在episode以降の証拠だけをAdvisorへ渡します。検出器は一般的な出力のヒューリスティックであり、誤検知し得ます。
証拠IDの存在と契約の構造は検証しますが、却下理由の技術的妥当性は診断モデル・ユーザーの判断です。

Advisorのbashは既定で禁止しています。テストコマンドは実コードを実行するため、
汎用 `node --test *` の許可は付けていません。必要な検証は親が通常権限で実行します。
NEXTのbashは単純なgit観測コマンドに限定します。Git設定自体を隔離するsandboxではありません。

状態には最大24件の証拠、各出力の先頭3000文字を含みます。秘密情報が入る出力の扱いに注意し、
`.gal-state/` をコミットしないでください。改行・タイミング以外の揺らぎは新しい証拠と判定される場合があります。
失敗したAdvisor呼び出しも予算を消費し、その場でEXHAUSTEDにします。

## 検証

開発テストはNode.js 24以降を使用します。

```sh
npm ci
npm test
npm run typecheck
opencode debug config
```

Qwenのテストは依頼文の事例から再構成したものです。未提供の実ログを取り込んだものではありません。
HEAD PASS / WORKTREE FAILの証拠登録、REFUTED仮説の再採用、TDDの8→3→1、
停止中の迂回拒否、契約した1操作、重複相談、2回制限、problem episode分離、関連編集だけの修正カウント、
NEXTの二段階実行・不一致解除・REPAIR、壊れた永続stateの修復、PowerShell/CLI誤用の分類、subagent分離、
verified completion後の再編集停止・fresh evidenceによるgal_reopen・再verificationでのcheckpoint再設定、
同一subjectのlow-novelty調査停滞・異なるsubjectの非誤検知・glob/grepの別queryが同じ空結果でも誤検知しないこと・editによるwindow reset・completion後の厳格閾値を検証します。
実モデルによる診断品質の評価は別途必要です。

`gal_status` のmetricsにはtool_calls、triggers、progress、gal_invocations、
advisor_accept/reject/repair、advisor_exhausted、recovery_starts、recovery_observations、next_contract_mismatches、
state_repairs、state_migrations、goal_gate_blocks、verification_passes、completion_markers、completion_checkpoints、post_success_blocks、completion_reopens、completion_reopen_edits、completion_invalidated、investigation_novel_observations、investigation_stale_observations、investigation_stall_triggers、unrelated_edits、shell_mismatches、cli_usage_errorsを記録します。
false_positive判定や解決率は自動推定しません。

## API根拠

実装は[V1.18.31のPlugin型定義](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/plugin/src/index.ts)
と[公式V1プラグイン説明](https://opencode.ai/docs/plugins/)に合わせています。
V2のPlugin.define、permissions配列、context.tools変更は使っていません。
エージェント設定はV1の `permission`、`bash`、`task` を使用します。
