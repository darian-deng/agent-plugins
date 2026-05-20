# Stage 6：全量验证

## 目标

对所有代码改动做完整的自动化验证，确保没有引入 lint 错误、类型错误或测试失败。

## 工作步骤

1. 运行项目的 lint 检查，将结果写入 `docs/feat-flows/{flow_id}/verification/lint.txt`
2. 运行 typecheck，将结果写入 `docs/feat-flows/{flow_id}/verification/typecheck.txt`
3. 运行测试套件，将结果写入 `docs/feat-flows/{flow_id}/verification/test.txt`
4. 如有失败：诊断根因，修复代码，git commit（message: `fix: resolve verification errors`），重新验证
5. 三个文件均无错误后，向用户展示验证摘要

## 验证命令参考（根据项目实际情况调整）

```bash
# lint
npx eslint . 2>&1 | tee docs/feat-flows/{flow_id}/verification/lint.txt

# typecheck
npx tsc --noEmit 2>&1 | tee docs/feat-flows/{flow_id}/verification/typecheck.txt

# test
npm test 2>&1 | tee docs/feat-flows/{flow_id}/verification/test.txt
```

## 完成条件

三个验证文件均存在，且无错误（由你判断输出内容是否 clean）。向用户展示验证结果摘要。

向 `.ai-flow/feat-flow/state/signal` 写入任意内容。等待用户确认验证通过后进入 Stage 7。
