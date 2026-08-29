#!/usr/bin/env node
/**
 * Batch rebuild CV JSON files from reports + cv.md, then regenerate HTML/PDF.
 * Removes location field from all experience entries.
 *
 * No personal data lives in this file: candidate contact info comes from
 * config/profile.yml (User Layer), CV content from batch/cv-rebuild-data.mjs
 * (gitignored). This script carries logic only.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import * as yaml from 'js-yaml';
import {
  BASE_EXPERIENCE,
  BASE_EDUCATION,
  BASE_CERTIFICATIONS,
  BASE_SKILLS,
  PDF_MAP,
  SUMMARIES,
  COMPETENCIES,
} from './batch/cv-rebuild-data.mjs';

// Candidate contact info — single source of truth is config/profile.yml.
function loadCandidate() {
  const profile = yaml.load(readFileSync(join(process.cwd(), 'config', 'profile.yml'), 'utf8'));
  const c = profile?.candidate ?? {};
  return {
    name: c.full_name ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    location: c.location ?? '',
    photo: '',
    photo_style: 'rounded',
  };
}

const CANDIDATE = loadCandidate();

function createJSON(reportId) {
  return {
    lang: "zh-CN",
    page_format: "a4",
    candidate: CANDIDATE,
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
  const json = createJSON(item.report);
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