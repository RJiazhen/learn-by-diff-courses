# Learn by Diff 课程仓库

本仓库存放 [Learn by Diff](https://github.com/RJiazhen/learn-by-diff) 的课程配置，不包含各课程的实现源码。

每一门课对应一个目录，内含 `course.yml` 与 `chapters/`。配置会指向外部源码仓库中的章节快照，并按「上一章的最终实现 = 下一章的起始代码」串联，用 diff 对照学习。

在编辑器中安装 Learn by Diff 扩展后，使用 **Open Course** 打开对应课程的 `course.yml` 即可开始。

## 课程列表

| 目录 | 课程 | 语言 | 说明 |
|------|------|------|------|
| [chibivue-zh-cn](./chibivue-zh-cn/course.yml) | chibivue：从一行 Hello, World 开始，逐步构建 | 简体中文 | 对照 [chibivue 在线书](https://book.chibivue.land/zh-cn/00-introduction/010-about.html)，从 `createApp` 逐步实现 Vue.js。源码来自 [chibivue](https://github.com/chibivue-land/chibivue) 的 `book/impls`。 |

后续课程会继续以独立目录的形式加入本仓库。
