#!/usr/bin/env node
/**
 * Batch rebuild CV JSON files from reports + cv.md, then regenerate HTML/PDF.
 * Removes location field from all experience entries.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, basename } from 'path';

// Base experience from cv.md (without location)
const BASE_EXPERIENCE = [
  {
    company: "北京小鸟科技股份有限公司",
    role: "软件项目经理",
    dates: "2021.04 – 2026.03",
    bullets: [
      "主导公司核心产品（显控平台、拼接处理器、混合矩阵、分布式系统）软件研发全流程管理，覆盖需求调研→原型设计→方案制定→项目落地。",
      "协调研发、测试、售前等跨部门资源，累计推进 100+ 项目成功实施，保障交付进度与质量。",
      "获 2022 年总经办红头文件嘉奖、2023 年\"幕后英雄\"称号。",
      "为机场运控大楼研发智能显控系统，可视化管理拼接处理器与坐席，设计热备/冷备机制保障运维连续性，带领 5 人团队按期交付。",
      "主导可视化综合管控系统华为红线测试认证（国内安全性要求最高的认证之一），带领 6 人团队历时 6 个月通过评审。"
    ]
  },
  {
    company: "北京小鸟科技股份有限公司",
    role: "技术经理",
    dates: "2019.01 – 2021.03",
    bullets: [
      "统筹多产品线（DMIS 可视化综合管控平台、拼接处理器、混合矩阵、分布式矩阵）显控能力，负责研发工程师面试与新人培训，建设技术梯队。",
      "编写并发布部门编码规范，主导多次软件架构重构，研发提效 60%。",
      "集成云技术、AI 智能识别与大数据分析，对音频、视频、网络、控制等多类设备统一综合管控。"
    ]
  },
  {
    company: "北京小鸟科技股份有限公司",
    role: "Java 软件开发工程师",
    dates: "2015.09 – 2018.12",
    bullets: [
      "参与核心音视频产品系统设计与 Java 开发，优化功能模块提升系统稳定性与运行效率。",
      "连续获 2016 公司级\"明日之星\"、2017 部门级\"月度之星\"、2018 公司级\"年度之星\"。"
    ]
  },
  {
    company: "郑州大方软件股份有限公司",
    role: "Java 软件开发工程师",
    dates: "2012.04 – 2015.01",
    bullets: [
      "线损综合管理系统（面向国家电网）：结合 SCADA/EMS/DMS 实时数据实现电网损耗测算。",
      "Kestrel 数据集成平台：研发元数据管理、任务调度、ETL/MAP/FTP 插件，支撑多源数据集成。"
    ]
  },
  {
    company: "河南浪潮软件技术有限公司",
    role: "Java 软件开发工程师",
    dates: "2010.02 – 2012.04",
    bullets: [
      "多个企业级系统（洛阳卷烟厂综合查询、思维产品质量追踪、驼人项目管理等）Java 开发与实施。"
    ]
  }
];

const BASE_EDUCATION = [
  { title: "大专 | Java 软件开发", org: "郑州大学", year: "2008 – 2010" }
];

const BASE_CERTIFICATIONS = [
  { title: "PMP 项目管理认证", org: "PMI", year: "" }
];

const BASE_SKILLS = [
  { category: "项目管理", items: "PMP、敏捷 Scrum、需求调研、WBS 拆解、进度/质量/风险管控、跨部门协调" },
  { category: "技术开发", items: "Java（精通9年+）、微服务、Flex、ExtJS、jQuery；Oracle/SQL Server/Sybase/SQLite" },
  { category: "领域经验", items: "音视频显控、拼接处理器、混合矩阵、分布式系统、数据集成平台(ETL)" },
  { category: "语言", items: "英语读写/听说熟练" }
];

// Report → PDF mapping
const PDF_MAP = [
  { report: "001-chaofujv-server-pm-2026-08-19", company: "超聚变", role: "服务器PM", pdf: "cv-马富荻-超聚变-服务器PM-2026-08-19" },
  { report: "002-chaofujv-general-server-pm-2026-08-19", company: "超聚变", role: "通用服务器PM", pdf: "cv-马富荻-超聚变-通用服务器PM-2026-08-19" },
  { report: "003-mixue-it-pm-2026-08-19", company: "蜜雪冰城", role: "IT项目经理", pdf: "cv-马富荻-蜜雪冰城-IT项目经理-2026-08-19" },
  { report: "004-beisen-hcm-pm-2026-08-19", company: "北森", role: "HCM项目经理", pdf: "cv-马富荻-北森-HCM项目经理-2026-08-19" },
  { report: "005-yonyou-henan-senior-pm-2026-08-19", company: "用友", role: "大项目经理", pdf: "cv-马富荻-用友-大项目经理-2026-08-19" },
  { report: "006-kingdee-senior-pm-2026-08-19", company: "金蝶", role: "大项目经理", pdf: "cv-马富荻-金蝶-大项目经理-2026-08-19" },
  { report: "007-keruisituo-sw-pm-2026-08-19", company: "科瑞思拓", role: "软件项目经理", pdf: "cv-马富荻-科瑞思拓-软件项目经理-2026-08-19" },
  { report: "018-henan-longyi-it-project-director-2026-08-22", company: "河南龙翼", role: "IT项目总监", pdf: "cv-ma-fudi-henan-longyi-2026-08-22" },
  { report: "024-muyuan-it-project-manager-2026-08-23", company: "牧原", role: "IT项目经理", pdf: "cv-ma-fudi-muyuan-2026-08-23" },
  { report: "026-jinyihui-2026-08-23", company: "金蚁汇", role: "软件项目经理", pdf: "cv-ma-fudi-jinyihui-2026-08-23" },
  { report: "027-mixue-it-pm-j12821-2026-08-23", company: "蜜雪冰城", role: "IT项目经理", pdf: "cv-candidate-mixue-it-pm-j12821-2026-08-23" },
  { report: "029-chaofubian-req-analysis-isc-2026-08-24", company: "超聚变", role: "需求分析SE-ISC", pdf: "cv-ma-fudi-chaofubian-2026-08-24" },
];

// Tailored summaries per report (extracted from report content)
const SUMMARIES = {
  "001-chaofujv-server-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，深耕音视频显控与分布式系统，8年软硬结合产品经验（拼接处理器/矩阵/光矩阵）。累计推进100+项目成功实施，管理跨职能团队峰值20人，带队通过华为红线测试（国内安全性要求最高的认证之一）。擅长需求调研→方案制定→项目落地的端到端交付，目标迁移至服务器/算力领域PM岗位。",
  "002-chaofujv-general-server-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，深耕音视频显控与分布式系统，8年软硬结合产品经验。累计推进100+项目成功实施，管理跨职能团队峰值20人，带队通过华为红线测试。擅长端到端交付与跨部门资源协调，目标迁移至通用服务器PM岗位。",
  "003-mixue-it-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备大型连锁餐饮企业IT项目管理能力。",
  "004-beisen-hcm-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，深耕音视频显控与分布式系统。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备SaaS/HCM领域项目交付能力。",
  "005-yonyou-henan-senior-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备ERP/财务/供应链领域项目交付能力。",
  "006-kingdee-senior-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备ERP/企业数字化领域项目交付能力。",
  "007-keruisituo-sw-pm-2026-08-19": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈，深耕音视频显控与分布式系统。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备IT服务交付与企业信息化项目管理能力。",
  "018-henan-longyi-it-project-director-2026-08-22": "16年软件研发与项目管理经验，PMP认证，深耕音视频显控与分布式系统。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长跨部门资源整合、研发流程规范建设与架构重构提效（研发提效60%），具备项目交付总监级管理能力。",
  "024-muyuan-it-project-manager-2026-08-23": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备大型制造型企业数字化项目管理能力。",
  "026-jinyihui-2026-08-23": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备金融科技/企业数字化转型项目管理能力。",
  "027-mixue-it-pm-j12821-2026-08-23": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。近6年从技术经理成长为软件项目经理，累计推进100+项目成功实施，管理跨职能团队峰值20人。擅长需求调研→方案制定→项目落地的端到端交付，具备餐饮零售信息系统建设与项目管理能力。",
  "029-chaofubian-req-analysis-isc-2026-08-24": "16年软件研发与项目管理经验，PMP认证，精通Java全栈技术栈。具备从需求调研、原型设计、方案制定到项目落地的端到端交付能力，累计推进100+项目成功实施。擅长需求分析与规格说明书编写，具备供应链/制造领域需求管理能力。"
};

// Tailored competencies per report
const COMPETENCIES = {
  "001-chaofujv-server-pm-2026-08-19": ["软硬结合产品项目管理", "华为系流程与认证", "端到端项目交付", "跨部门资源协调", "需求分析与方案落地", "进度/质量/风险管控", "团队管理（峰值20人）", "服务器/算力领域快速学习"],
  "002-chaofujv-general-server-pm-2026-08-19": ["软硬结合产品项目管理", "华为系流程与认证", "端到端项目交付", "跨部门资源协调", "需求分析与方案落地", "进度/质量/风险管控", "团队管理（峰值20人）", "通用服务器PM"],
  "003-mixue-it-pm-2026-08-19": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "Java全栈技术", "餐饮零售信息系统", "团队管理（峰值20人）", "需求分析与方案落地"],
  "004-beisen-hcm-pm-2026-08-19": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "SaaS/HCM领域", "团队管理（峰值20人）", "需求分析与方案落地", "企业数字化项目"],
  "005-yonyou-henan-senior-pm-2026-08-19": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "ERP/财务/供应链", "团队管理（峰值20人）", "需求分析与方案落地", "企业数字化项目"],
  "006-kingdee-senior-pm-2026-08-19": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "ERP/企业数字化", "团队管理（峰值20人）", "需求分析与方案落地", "大型项目交付"],
  "007-keruisituo-sw-pm-2026-08-19": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "Java全栈技术", "IT服务交付", "团队管理（峰值20人）", "需求分析与方案落地"],
  "018-henan-longyi-it-project-director-2026-08-22": ["项目交付总监级管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "研发流程规范建设", "架构重构提效60%", "团队管理（峰值20人）", "需求分析与方案落地"],
  "024-muyuan-it-project-manager-2026-08-23": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "数字化项目规划", "团队管理（峰值20人）", "需求分析与方案落地", "制造型企业IT"],
  "026-jinyihui-2026-08-23": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "金融科技/数字化转型", "团队管理（峰值20人）", "需求分析与方案落地", "企业信息化"],
  "027-mixue-it-pm-j12821-2026-08-23": ["软件项目全生命周期管理", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "Java全栈技术", "餐饮零售信息系统", "团队管理（峰值20人）", "需求分析与方案落地"],
  "029-chaofubian-req-analysis-isc-2026-08-24": ["需求分析与规格化", "敏捷 Scrum / PMP", "跨部门资源协调", "进度/质量/风险管控", "全生命周期跟踪", "供应链/制造领域", "团队管理（峰值20人）", "业务需求转化"]
};

function createJSON(reportId, company, role) {
  return {
    lang: "zh-CN",
    page_format: "a4",
    candidate: {
      name: "马富荻",
      phone: "+86-15981820753",
      email: "751861646@qq.com",
      location: "郑州",
      photo: "",
      photo_style: "rounded"
    },
    sections: {
      summary: "个人优势",
      competencies: "核心能力",
      experience: "工作经历",
      projects: "项目经历",
      education: "教育经历",
      certifications: "资格证书",
      skills: "技能"
    },
    summary: SUMMARIES[reportId] || SUMMARIES["001-chaofujv-server-pm-2026-08-19"],
    competencies: COMPETENCIES[reportId] || COMPETENCIES["001-chaofujv-server-pm-2026-08-19"],
    experience: BASE_EXPERIENCE,
    projects: [
      { name: "深圳机场运控智能显控系统", badge: "大型客户交付", tech: "显控平台 / 分布式系统", description: "为机场运控大楼研发智能显控系统，可视化管理拼接处理器与坐席，热备/冷备保障运维连续性；带领 5 人团队按期交付。" },
      { name: "华为红线测试认证", badge: "顶级安全认证", tech: "可视化综合管控系统", description: "带领 6 人团队历时 6 个月通过华为红线测试（国内安全性要求最高的认证之一），获总经办红头文件嘉奖。" },
      { name: "DMIS 可视化综合管控平台", badge: "多产品线架构", tech: "云技术 / AI 智能识别 / 大数据", description: "统筹多产品线显控能力，集成云技术、AI 智能识别与大数据分析，对多类设备统一综合管控。" },
      { name: "Kestrel 数据集成平台", badge: "数据集成", tech: "ETL / MAP / FTP", description: "研发元数据管理、任务调度、ETL/MAP/FTP 插件，支撑多源数据集成。" }
    ],
    education: BASE_EDUCATION,
    certifications: BASE_CERTIFICATIONS,
    skills: BASE_SKILLS
  };
}

// Main
const reportsDir = join(process.cwd(), 'reports');
const outputDir = join(process.cwd(), 'output');

let updated = 0;
let skipped = 0;

for (const item of PDF_MAP) {
  const jsonPath = join(outputDir, `${item.pdf}.json`);
  const htmlPath = join(outputDir, `${item.pdf}.html`);
  const pdfPath = join(outputDir, `${item.pdf}.pdf`);
  
  console.log(`\n📝 Processing: ${item.pdf}`);
  
  // Create JSON
  const json = createJSON(item.report, item.company, item.role);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  console.log(`  ✅ JSON created: ${item.pdf}.json`);
  
  // Build HTML
  try {
    execSync(`node build-cv-html.mjs "${jsonPath}" "${htmlPath}"`, { cwd: process.cwd(), stdio: 'pipe' });
    console.log(`  ✅ HTML built: ${item.pdf}.html`);
  } catch (e) {
    console.log(`  ❌ HTML build failed: ${e.message}`);
    skipped++;
    continue;
  }
  
  // Generate PDF with --report flag for pdf-index.tsv linkage
  const reportNum = item.report.split('-')[0]; // e.g. "001" from "001-chaofujv-server-pm-2026-08-19"
  try {
    execSync(`node generate-pdf.mjs "${htmlPath}" "${pdfPath}" --format=a4 --report=${reportNum}`, { cwd: process.cwd(), stdio: 'pipe' });
    console.log(`  ✅ PDF generated: ${item.pdf}.pdf (report=${reportNum})`);
    updated++;
  } catch (e) {
    console.log(`  ❌ PDF generation failed: ${e.message}`);
    skipped++;
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`✅ Updated: ${updated} PDFs`);
console.log(`❌ Skipped: ${skipped} PDFs`);
console.log(`${'='.repeat(50)}`);
