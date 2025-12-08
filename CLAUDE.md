# Rules

常に以下のルールに従ってください

- 常に日本語で応対すること
- npm を実行する際に frontend ディレクトリに移動する必要がある場合、cd を使う
  のではなくて --prefix オプションを使うこと
- コミットは指示があるまで行わないこと

## タスク完了時のチェックリスト

各タスク完了前に以下を実行すること:

1. `npm run lint --prefix frontend` - ESLint によるコード品質チェック
2. `npm run format:check --prefix frontend` - Biome によるフォーマットチェック
3. `npm run typecheck --prefix frontend` - TypeScript の型チェック

すべてのチェックがパスしたら:

4. タスクに実装の重要なポイントを追記
5. コミットを作成
6. vibe-kanban のタスクステータスを done に更新
