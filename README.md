<div align="center">

# 🗂️ SQL / DBML → ER 图生成器

**优雅的在线 SQL 建表语句转 ER 图工具**

[English](README.en.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ystemsrx/sql_to_ER?style=flat-square&color=gold)](https://github.com/ystemsrx/sql_to_ER/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/ystemsrx/sql_to_ER?style=flat-square&color=blue)](https://github.com/ystemsrx/sql_to_ER/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/ystemsrx/sql_to_ER?style=flat-square&color=red)](https://github.com/ystemsrx/sql_to_ER/issues)
[![Last Commit](https://img.shields.io/github/last-commit/ystemsrx/sql_to_ER?style=flat-square&color=green)](https://github.com/ystemsrx/sql_to_ER/commits)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)](#)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](#)

### 🌐 [**在线体验 · Live Demo**](https://ystemsrx.github.io/sql_to_ER/sql2er.html)

</div>

---

## ✨ 项目简介

一个基于网页的**纯前端**工具，用于从 SQL `CREATE TABLE` 语句和 DBML 代码生成 **Chen 模型 ER 图**。无需登录，无需付费，完全免费开源。

> [!NOTE]
> 为什么做这个？市面上绝大多数 DBML/SQL 转 ER 图的在线工具都需要登录甚至收费，且样式奇丑无比，体验令人失望。于是直接开源一个免费替代品。

> [!TIP]
> 如果你需要绘制的是**逻辑模型**（而非 Chen 模型），推荐使用 [dbdiagram.io](https://dbdiagram.io/)，同样免费。

---

## 🚀 快速使用

直接访问在线版本即可使用，**无需安装**：

🔗 **[ER Diagram Generator](https://ystemsrx.github.io/sql_to_ER/sql2er.html)**

或者克隆到本地运行：

```bash
git clone https://github.com/ystemsrx/sql_to_ER.git
cd sql_to_ER
```

> [!WARNING]
> **请勿直接双击打开 `sql2er.html`**。由于浏览器对 `file://` 协议的安全限制，CSS / JS 资源将无法正常加载，页面会显示空白或报错。请使用任意本地 HTTP 服务器启动，例如：
>
> ```bash
> # 方式一：Python 3（推荐，无需额外安装）
> python -m http.server 8000
>
> # 方式二：Node.js
> npx serve .
>
> # 方式三：VS Code "Live Server" 扩展
> ```
>
> 然后在浏览器访问 `http://localhost:8000/sql2er.html` 即可。

---

## 📖 使用步骤

1. 通过本地 HTTP 服务器打开 `sql2er.html`（参见上方快速使用，或直接访问在线版）
2. 在输入区粘贴 **SQL `CREATE TABLE`** 语句或 **DBML** 代码
3. 点击 **「生成 ER 图」** 按钮
4. 若对节点位置不满意，可**拖拽节点**调整布局；**双击节点**修改内容
5. 在画布上使用**滚轮**可平滑缩放，按住 **Ctrl + 滚轮**可围绕图形中心平滑旋转（节点形状与文字方向保持不变）
6. 若图形较复杂，只需将每个矩形（实体）拖到大致位置，再点击 **「智能优化」**，即可自动整理布局

---

## 🧩 支持格式

<details open>
<summary><b>📘 SQL 示例</b></summary>

```sql
CREATE TABLE users (
    id INT PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE
);

CREATE TABLE posts (
    id INT PRIMARY KEY,
    author_id INT,
    title VARCHAR(255),
    FOREIGN KEY (author_id) REFERENCES users(id)
);
```

</details>

<details open>
<summary><b>📗 DBML 示例</b></summary>

```dbml
Table users {
  id INT [pk]
  username VARCHAR(255) [not null]
  email VARCHAR(255) [unique]
}

Table posts {
  id INT [pk]
  author_id INT
  title VARCHAR(255)
}

Ref: posts.author_id > users.id
```

</details>

---

## 🎨 Chen 模型元素

|     图形      | 含义     | 对应数据库概念 |
| :-----------: | :------- | :------------- |
|  🟦 **矩形**  | 实体     | 表             |
|  🔶 **菱形**  | 关系     | 外键           |
|  ⚪ **椭圆**  | 属性     | 列             |
| <u>下划线</u> | 主键标识 | 主键属性       |

---

## ⚖️ 与标准 Chen 模型的差异

> [!IMPORTANT]
> 本工具为简化使用，在以下方面对标准 Chen 模型做了妥协。如需严格符合学术规范，请参考下方说明手动调整。

- **关系命名**：标准 Chen 模型要求菱形使用语义化名称（如 _属于_、_拥有_），本工具默认显示外键字段名。
- **实体与属性命名**：标准建议使用业务术语，本工具默认直接使用表名与列名。
- **自定义修改**：
  - ✏️ **双击** 图形元素可直接编辑显示内容
  - 🔁 或在源代码（SQL / DBML）中修改后重新生成

---

## 🖼️ 效果展示

![示例 1](./assets/eg1.png)

> [!TIP]
> 代码较复杂时，直接生成的图可能不够整齐。此时：
>
> 1. 点击 **「智能布局」** 自动整理——通常此时已足够整齐，仅需微调。
> 2. 若仍不理想，点击 **「强制对齐」** 进行更激进的对齐排列，再配合「智能布局」通常可得到理想效果。
> 3. 极少数情况下，可先**手动**将矩形（实体）拖到合适位置（其他元素无需调整），再点击「智能布局」即可。
> 4. **实体 / 关系特别多时**，可先点击画布左上角的 **「隐藏属性」**，先把矩形（实体）和菱形（关系）骨架摆到理想位置，再点一次切换回「显示属性」——属性会自动根据当前矩形的位置围绕其均匀分布，避免一上来就被属性干扰拖动。

<table>
<tr>
<td width="50%" align="center">
<h4>🔧 直接生成</h4>
<img src="./assets/eg2.png" alt="Direct Generation"/>
</td>
<td width="50%" align="center">
<h4>✨ 先对齐 + 智能布局</h4>
<img src="./assets/eg2_opt.png" alt="Optimized Layout"/>
</td>
</tr>
</table>

---

## 🕘 生成历史

每次生成 ER 图时都会自动保存一份**快照**（含缩略图、节点位置、当前显示设置），整理过的布局不会因为重新生成而丢失。

![生成历史](./assets/eg-history.png)

- **打开**：点击画布左上角的 **🕘 时钟图标**打开历史页面。
- **浏览**：直接 **拖拽** 卡片，或在面板上 **滚轮** 翻动；最近的快照在最前面。
- **恢复**：拖拽任意卡片先把它吸附到中央，再次点击「恢复」即可按当时的节点位置 / 标签重建图（不会重新布局）。
- **删除**：单张快照右下角的 **🗑** 按钮可单独移除该条记录。
- **持久化**：所有数据都存在浏览器本地的 **IndexedDB** 中（首次生成非示例 ER 图后才会出现条目）。

> [!TIP]
> 想撤回上一次手动调整？面板里的「恢复」是按输入文本归档的版本切换，单步撤销 / 重做请用 **Ctrl + Z / Ctrl + Y**。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！如果这个项目对你有帮助，请点一个 ⭐ Star 支持一下。

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
