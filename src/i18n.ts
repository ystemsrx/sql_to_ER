export const I18N = {
        zh: {
          eyebrow: "Chen Model · Entity-Relationship",
          title: "SQL / DBML 转 <em>ER 图</em> 生成器",
          subtitle: "把建表语句或 DBML 一键渲染为 Chen 模型实体-关系图",
          hint: '<span class="header-hint-row">双击编辑节点 · 滚轮缩放 · Ctrl+滚轮旋转 · 拖拽排布</span><span class="header-hint-row header-hint-row--secondary">Ctrl+Z 撤销 / Ctrl+Y 重做</span>',
          pageTitle: "SQL/DBML2ER",
          cardInputTitle: "SQL / DBML",
          cardPreviewTitle: "ER 图预览",
          showComment: "展示 COMMENT",
          hideFields: "隐藏属性",
          editorPlaceholder: "在此处粘贴您的 CREATE TABLE 或 DBML 语句...",
          btnGenerate: "⚡ 生成 ER 图",
          btnGenerateShort: "⚡ 生成",
          btnExport: "📥 导出 SVG",
          btnExportPNG: "📥 导出 PNG",
          btnExportXML: "📥 导出 XML",
          btnExportLabel: "导出",
          exportGenerating: "生成",
          exportSaved: "已保存",
          btnSmartLayout: "✨ 智能布局",
          btnForceAlign: "📐 强制对齐",
          legendEntity: "实体",
          legendRelation: "关系",
          legendAttribute: "属性",
          legendPk: "主键",
          tipShowBg: "显示背景",
          tipHideBg: "隐藏背景",
          tipColorOn: "开启着色",
          tipColorOff: "关闭着色",
          tipShowAttrs: "显示属性",
          tipHideAttrs: "隐藏属性",
          tipForceOn: "开启持续力导向",
          tipForceOff: "关闭持续力导向",
          tipHistory: "查看生成历史",
          historyTitle: "生成历史",
          historyEmpty: "暂无历史记录",
          historyEmptyHint: "每次生成 ER 图后会自动保存快照",
          historyHint: "拖拽或滚轮浏览 · 点击恢复",
          historyRestore: "恢复",
          historyDelete: "删除",
          historyClose: "关闭",
          historyEntities: "个实体",
          historyColored: "彩色",
          historyMono: "黑白",
          historyAttrsHidden: "隐藏属性",
          historyComment: "显示注释",
          errEmpty: "输入为空。",
          errNoTable:
            "未找到有效的 CREATE TABLE 或 Table 定义。请确保您的 SQL 或 DBML 语法正确。",
          errParse: "SQL 解析失败",
          errParseHint: "。请检查 SQL 语法是否正确。",
          sample: `-- 示例 DBML，请在此处粘贴您的 DBML 或 SQL 语句
Table 用户 {
  编号 INT [pk, increment]
  用户名 VARCHAR(255) [not null]
  邮箱 VARCHAR(255) [unique]
  创建时间 TIMESTAMP
}

Table 国家 {
  编号 INT [pk]
  名称 VARCHAR(255) [not null]
}

Table 文章 {
  文章编号 INT [pk]
  内容 TEXT
}

Ref: 用户.属于 > 国家.编号
Ref: 文章.作者 > 用户.编号
`,
        },
        en: {
          eyebrow: "Chen Model · Entity-Relationship",
          title: "Turn SQL / DBML into an <em>ER Diagram</em>",
          subtitle:
            "Render CREATE TABLE statements or DBML as a Chen-model entity-relationship diagram",
          hint: '<span class="header-hint-row">Double-click to edit · Scroll to zoom · Ctrl+Scroll to rotate · Drag to arrange</span><span class="header-hint-row header-hint-row--secondary">Ctrl+Z undo / Ctrl+Y redo</span>',
          pageTitle: "SQL/DBML2ER",
          cardInputTitle: "SQL / DBML",
          cardPreviewTitle: "ER Preview",
          showComment: "Show comments",
          hideFields: "Hide attributes",
          editorPlaceholder:
            "Paste your CREATE TABLE or DBML statement here...",
          btnGenerate: "⚡ Generate",
          btnGenerateShort: "⚡ Gen",
          btnExport: "📥 Export SVG",
          btnExportPNG: "📥 Export PNG",
          btnExportXML: "📥 Export XML",
          btnExportLabel: "Export",
          exportGenerating: "Generating",
          exportSaved: "Saved",
          btnSmartLayout: "✨ Smart layout",
          btnForceAlign: "📐 Force align",
          legendEntity: "Entity",
          legendRelation: "Relationship",
          legendAttribute: "Attribute",
          legendPk: "Primary key",
          tipShowBg: "Show background",
          tipHideBg: "Hide background",
          tipColorOn: "Enable color",
          tipColorOff: "Disable color",
          tipShowAttrs: "Show attributes",
          tipHideAttrs: "Hide attributes",
          tipForceOn: "Enable continuous force",
          tipForceOff: "Disable continuous force",
          tipHistory: "View generation history",
          historyTitle: "Generation history",
          historyEmpty: "No history yet",
          historyEmptyHint:
            "A snapshot is saved every time you generate the ER diagram",
          historyHint: "Drag or scroll to browse · Click a card to restore",
          historyRestore: "Restore",
          historyDelete: "Delete",
          historyClose: "Close",
          historyEntities: "entities",
          historyColored: "Colored",
          historyMono: "Mono",
          historyAttrsHidden: "Attrs hidden",
          historyComment: "Comments",
          errEmpty: "Input is empty.",
          errNoTable:
            "No valid CREATE TABLE or Table definition found. Make sure your SQL or DBML syntax is correct.",
          errParse: "SQL parsing failed",
          errParseHint: ". Please check your SQL syntax.",
          sample: `-- Sample DBML — paste your DBML or SQL statements here
Table User {
  ID INT [pk, increment]
  Username VARCHAR(255) [not null]
  Email VARCHAR(255) [unique]
  CreatedAt TIMESTAMP
}

Table Country {
  ID INT [pk]
  Name VARCHAR(255) [not null]
}

Table Article {
  ArticleID INT [pk]
  Content TEXT
}

Ref: User.BelongsTo > Country.ID
Ref: Article.Author > User.ID
`,
        },
      } as const;

export type Language = keyof typeof I18N;
