<div align="center">

# 🗂️ SQL / DBML → ER Diagram Generator

**Elegant online tool to convert SQL table creation statements into ER diagrams**

[English](README.en.md) · **Simplified Chinese**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ystemsrx/sql_to_ER?style=flat-square&color=gold)](https://github.com/ystemsrx/sql_to_ER/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/ystemsrx/sql_to_ER?style=flat-square&color=blue)](https://github.com/ystemsrx/sql_to_ER/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/ystemsrx/sql_to_ER?style=flat-square&color=red)](https://github.com/ystemsrx/sql_to_ER/issues)
[![Last Commit](https://img.shields.io/github/last-commit/ystemsrx/sql_to_ER?style=flat-square&color=green)](https://github.com/ystemsrx/sql_to_ER/commits)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)](#)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](#)

### 🌐 [**Try Online · Live Demo**](https://ystemsrx.github.io/sql_to_ER/sql2er.html)

</div>

---

## ✨ Overview

A **pure front-end** web tool for generating **Chen-model ER diagrams** from SQL `CREATE TABLE` statements and DBML code. No login, no payment, fully free and open source.

> [!TIP]
> If you need a **logical model** (rather than the Chen model), we recommend [dbdiagram.io](https://dbdiagram.io) — also free.

---

## 🚀 Quick Start

The easiest way — just open the **online version**, no installation needed:

🔗 **[ER Diagram Generator](https://ystemsrx.github.io/sql_to_ER/sql2er.html)**

Or run it locally:

```bash
git clone https://github.com/ystemsrx/sql_to_ER.git
cd sql_to_ER
```

> [!WARNING]
> **Do not open `sql2er.html` by double-clicking it.** Due to browser security restrictions on the `file://` protocol, CSS / JS resources will fail to load and the page will render blank or error out. Start a local HTTP server instead:
>
> ```bash
> # Option 1: Python 3 (recommended, no extra install)
> python -m http.server 8000
>
> # Option 2: Node.js
> npx serve .
>
> # Option 3: VS Code "Live Server" extension
> ```
>
> Then visit `http://localhost:8000/sql2er.html` in your browser.

---

## 📖 Usage

1. Serve `sql2er.html` via a local HTTP server (see Quick Start above, or just use the online demo)
2. Paste your **SQL `CREATE TABLE`** statements or **DBML** code into the input area
3. Click the **"Generate ER Diagram"** button
4. If you are not happy with node positions, **drag nodes** to adjust; **double-click** a node to edit its content
5. For complex diagrams, drag each rectangle (entity) roughly to the desired position, then click **"Smart Optimization"** to auto-arrange the layout

---

## 🧩 Supported Formats

<details open>
<summary><b>📘 SQL Example</b></summary>

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
<summary><b>📗 DBML Example</b></summary>

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

## 🎨 Chen Model Elements

|      Shape       | Meaning            | Database Concept      |
| :--------------: | :----------------- | :-------------------- |
| 🟦 **Rectangle** | Entity             | Table                 |
|  🔶 **Diamond**  | Relationship       | Foreign Key           |
|  ⚪ **Ellipse**  | Attribute          | Column                |
| <u>Underline</u> | Primary Key marker | Primary Key attribute |

---

## ⚖️ Differences from the Standard Chen Model

> [!IMPORTANT]
> For ease of use, this tool deviates from the standard Chen model in the following ways. If you need strict academic correctness, adjust manually per the notes below.

- **Relationship Naming** — The standard Chen model expects diamonds to carry semantic names (e.g., _belongs to_, _owns_). This tool displays the foreign-key field name by default.
- **Entity & Attribute Naming** — The standard recommends business terminology. This tool uses raw database table and column names by default.
- **Custom Editing**
  - ✏️ **Double-click** any graphical element to edit its display content
  - 🔁 Or modify the source (SQL / DBML) and regenerate

---

## 🖼️ Showcase

![Example 1](./assets/eg1.png)

> [!TIP]
> When the code is complex, the initial diagram may not be tidy. In that case:
>
> 1. Click **"Smart Layout"** for auto-arrangement — this usually produces a reasonably clean result with only minor tweaks needed.
> 2. If still messy, click **"Force Alignment"** for a more aggressive alignment pass, then use "Smart Layout" again for an ideal result.
> 3. In rare cases, **manually** drag the rectangles (entities) to suitable positions (no need to move other elements), then click "Smart Layout".

<table>
<tr>
<td width="50%" align="center">
<h4>🔧 Direct Generation</h4>
<img src="./assets/eg2.png" alt="Direct Generation"/>
</td>
<td width="50%" align="center">
<h4>✨ Align + Smart Layout</h4>
<img src="./assets/eg2_opt.png" alt="Optimized Layout"/>
</td>
</tr>
</table>

---

## 🤝 Contributing

Issues and Pull Requests are welcome! If this project helps you, please leave a ⭐ Star — it really motivates further work.

---

## 📄 License

Released under the [MIT License](./LICENSE).
