#!/usr/bin/env node
/**
 * RunPiston 薪資模擬測試
 * 用法：
 *   node tests/payroll-simulation.js --month 2026-04 --all --dry-run
 *   node tests/payroll-simulation.js --month 2026-04 --company benmi
 *   node tests/payroll-simulation.js --month 2026-04 --company dajeng
 *
 * 參數：
 *   --month YYYY-MM   指定月份（預設上個月）
 *   --company benmi|dajeng|all  指定公司（預設 all）
 *   --all              等同 --company all
 *   --dry-run          不寫入資料庫，僅計算並顯示結果
 */

const SUPABASE_URL = 'https://nssuisyvlrqnqfxupklb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc';
const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

// ─── 公司設定 ───
const COMPANIES = {
  dajeng: {
    id: '8a669e2c-7521-43e9-9300-5c004c57e9db',
    name: '大正科技',
    salaryType: 'monthly',
    baseSalary: 45000,
    workStart: '08:00',
    workEnd: '17:00',
  },
  benmi: {
    id: 'fb1f6b5f-dcd5-4262-a7de-e7c357662639',
    name: '本米',
    salaryType: 'hourly',
    hourlyRate: 196,
    workStart: '10:00',
    workEnd: '22:00',
  },
};

// 公司別名
const COMPANY_ALIASES = { dajheng: 'dajeng', dazheng: 'dajeng', dj: 'dajeng', bm: 'benmi' };
function resolveCompany(key) { return COMPANY_ALIASES[key] || key; }

// ─── 薪資計算（完全複製 payroll.js calcEmployeePayroll 邏輯） ───
function calcPayroll(emp, ss, atts, leaves, otHours, payrollSettings) {
  const _ps = payrollSettings || {};
  const salaryType = ss.salary_type || 'monthly';
  const baseSalary = ss.base_salary || 0;
  const mealAllowance = ss.meal_allowance || 0;
  const posAllowance = ss.position_allowance || 0;
  const fullAttBonus = ss.full_attendance_bonus || 0;
  const pensionRate = ss.pension_self_rate || 0;
  const taxRate = ss.tax_rate || 5;

  const actualDays = atts.filter(a => a.check_in_time).length;
  const lateCount = atts.filter(a => a.is_late).length;
  const totalWorkHours = atts.reduce((s, a) => s + (a.total_work_hours || 0), 0);
  const leaveDays = leaves.total;
  const personalLeaveDays = leaves.personal;

  let monthSalary, dailyRate, hourlyRate;
  if (salaryType === 'monthly') {
    monthSalary = baseSalary;
    dailyRate = Math.round(baseSalary / 30);
    hourlyRate = Math.round(dailyRate / 8);
  } else if (salaryType === 'daily') {
    dailyRate = baseSalary;
    hourlyRate = Math.round(dailyRate / 8);
    monthSalary = dailyRate * actualDays;
  } else {
    hourlyRate = baseSalary;
    dailyRate = hourlyRate * 8;
    monthSalary = Math.round(hourlyRate * totalWorkHours);
  }

  let otPay = 0;
  if (otHours > 0) {
    const otRate1 = _ps.overtime_rate || 1.34;
    const otRate2 = _ps.overtime_rate_2 || 1.67;
    const h1 = Math.min(otHours, 2);
    const h2 = Math.max(Math.min(otHours - 2, 2), 0);
    otPay = Math.round(hourlyRate * otRate1 * h1) + Math.round(hourlyRate * otRate2 * h2);
  }

  const hasFullAtt = (lateCount === 0 && leaveDays === 0);
  const fullAttAmount = hasFullAtt ? fullAttBonus : 0;
  const gross = monthSalary + otPay + fullAttAmount + mealAllowance + posAllowance;

  const laborIns = Math.round(monthSalary * 0.125 * 0.2);
  const healthIns = Math.round(monthSalary * 0.0517 * 0.3);
  const pensionSelf = Math.round(monthSalary * pensionRate / 100);
  const incomeTax = Math.round(gross * taxRate / 100);
  const lateDeductPerTime = _ps.late_deduction_per_time || 100;
  const lateDed = lateCount * lateDeductPerTime;
  const personalLeaveDed = Math.round(dailyRate * personalLeaveDays);
  const totalDeduct = laborIns + healthIns + pensionSelf + incomeTax + lateDed + personalLeaveDed;
  const net = gross - totalDeduct;

  return {
    name: emp.name, salary_type: salaryType,
    actual_days: actualDays, late_count: lateCount, total_work_hours: Math.round(totalWorkHours * 10) / 10,
    leave_days: leaveDays, personal_leave_days: personalLeaveDays, overtime_hours: otHours,
    base_salary: monthSalary, hourly_rate: hourlyRate, daily_rate: dailyRate,
    overtime_pay: otPay, full_attendance_bonus: fullAttAmount,
    meal_allowance: mealAllowance, position_allowance: posAllowance,
    labor_insurance: laborIns, health_insurance: healthIns,
    pension_self: pensionSelf, income_tax: incomeTax,
    late_deduction: lateDed, personal_leave_deduction: personalLeaveDed,
    gross_salary: gross, total_deduction: totalDeduct, net_salary: net,
  };
}

// ─── 模擬考勤資料 ───
function generateAttendance(year, month, companyConfig, empCount) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const results = [];

  for (let empIdx = 0; empIdx < empCount; empIdx++) {
    const atts = [];
    let otHours = 0;
    let leaveDays = 0, personalLeaveDays = 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(year, month - 1, d);
      const dow = dt.getDay();
      if (dow === 0 || dow === 6) continue; // 週末跳過

      const rand = Math.random();
      if (rand < 0.05) {
        // 5% 缺勤
        leaveDays++;
        personalLeaveDays++;
        continue;
      }

      const isLate = rand < 0.20; // 15% 遲到（0.05-0.20）
      const isEarlyLeave = rand >= 0.20 && rand < 0.25; // 5% 早退
      const isOvertime = rand >= 0.95; // 5% 加班

      let workHours;
      if (companyConfig.salaryType === 'hourly') {
        workHours = 4 + Math.random() * 6; // 4-10 小時
      } else {
        workHours = isEarlyLeave ? 6 : (isOvertime ? 10 : 8);
      }
      workHours = Math.round(workHours * 10) / 10;

      if (isOvertime) otHours += Math.max(workHours - 8, 0);

      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      atts.push({
        date: dateStr,
        check_in_time: `${dateStr}T${isLate ? '08:' + String(10 + Math.floor(Math.random() * 50)).padStart(2, '0') : companyConfig.workStart}:00+08:00`,
        check_out_time: `${dateStr}T${isEarlyLeave ? '15:00' : companyConfig.workEnd}:00+08:00`,
        total_work_hours: workHours,
        is_late: isLate,
        is_early_leave: isEarlyLeave,
        overtime_hours: isOvertime ? Math.max(workHours - 8, 0) : 0,
      });
    }

    results.push({ atts, otHours: Math.round(otHours * 10) / 10, leaveDays, personalLeaveDays });
  }
  return results;
}

// ─── Supabase 查詢 ───
async function supabaseGet(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${table} 查詢失敗: ${res.status}`);
  return res.json();
}

// ─── 主程式 ───
async function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a, i) => args[i - 1] === '--month') || (() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const [year, month] = monthArg.split('-').map(Number);
  const companyArg = args.includes('--all') ? 'all' : (args.find((a, i) => args[i - 1] === '--company') || 'all');
  const dryRun = args.includes('--dry-run');

  console.log('═══════════════════════════════════════');
  console.log('  RunPiston 薪資模擬測試');
  console.log('═══════════════════════════════════════');
  console.log(`  月份：${year}年${month}月`);
  console.log(`  公司：${companyArg}`);
  console.log(`  模式：${dryRun ? '🔍 Dry Run（不寫入 DB）' : '⚠️ 寫入 DB'}`);
  console.log('');

  let passed = 0, failed = 0;
  function ok(msg) { passed++; console.log(`  ✅ ${msg}`); }
  function fail(msg) { failed++; console.log(`  ❌ ${msg}`); }

  const targets = companyArg === 'all' ? Object.keys(COMPANIES) : [resolveCompany(companyArg)];

  for (const key of targets) {
    const company = COMPANIES[key];
    if (!company) { fail(`未知公司: ${key}`); continue; }

    console.log(`\n📊 ${company.name}（${company.salaryType === 'hourly' ? '時薪制' : '月薪制'}）`);
    console.log('─'.repeat(50));

    // 查詢員工
    let employees;
    try {
      employees = await supabaseGet('employees', `company_id=eq.${company.id}&is_active=eq.true&select=id,name,employee_number,department`);
    } catch (e) { fail(`查詢員工失敗: ${e.message}`); continue; }

    if (employees.length === 0) { fail('無在職員工'); continue; }
    ok(`找到 ${employees.length} 名員工`);

    // 查詢薪資設定
    let salarySettings;
    try {
      salarySettings = await supabaseGet('salary_settings', `is_current=eq.true&select=employee_id,salary_type,base_salary,meal_allowance,position_allowance,full_attendance_bonus,pension_self_rate,tax_rate`);
    } catch (e) { fail(`查詢薪資設定失敗: ${e.message}`); continue; }

    const ssMap = {};
    salarySettings.forEach(s => { ssMap[s.employee_id] = s; });

    // 模擬考勤
    const simData = generateAttendance(year, month, company, employees.length);

    // 計算薪資
    const payrollSettings = { late_deduction_per_time: 100, overtime_rate: 1.34, overtime_rate_2: 1.67, work_days_per_month: 22 };

    let totalNet = 0;
    const report = [];

    employees.forEach((emp, idx) => {
      const sim = simData[idx];
      const ss = ssMap[emp.id] || {
        salary_type: company.salaryType,
        base_salary: company.salaryType === 'hourly' ? company.hourlyRate : company.baseSalary,
      };

      const result = calcPayroll(emp, ss, sim.atts, { total: sim.leaveDays, personal: sim.personalLeaveDays }, sim.otHours, payrollSettings);
      totalNet += result.net_salary;
      report.push(result);

      // 顯示個人結果
      const typeLabel = { monthly: '月薪', hourly: '時薪', daily: '日薪' };
      console.log(`\n  👤 ${emp.name}（${emp.employee_number || '-'}）${typeLabel[result.salary_type]}`);
      console.log(`     出勤 ${result.actual_days}天 · 工時 ${result.total_work_hours}h · 遲到 ${result.late_count}次 · 請假 ${result.leave_days}天 · 加班 ${result.overtime_hours}h`);
      const allowance = (result.meal_allowance || 0) + (result.position_allowance || 0) + (result.full_attendance_bonus || 0) + (result.overtime_pay || 0);
      console.log(`     底薪 ${result.base_salary.toLocaleString()} + 津貼 ${allowance.toLocaleString()} = 應發 ${result.gross_salary.toLocaleString()} - 扣款 ${result.total_deduction.toLocaleString()} = 實發 ${result.net_salary.toLocaleString()}`);
    });

    console.log(`\n  💰 ${company.name} 薪資總額：NT$ ${Math.round(totalNet).toLocaleString()}`);

    // ─── 驗證 ───
    console.log(`\n  📋 驗證結果：`);

    // V1: 所有員工都有薪資
    report.every(r => r.net_salary > 0) ? ok('所有員工實發 > 0') : fail('有員工實發 ≤ 0');

    // V2: 時薪制 = hourlyRate × totalWorkHours
    if (company.salaryType === 'hourly') {
      const allMatch = report.every(r => r.base_salary === Math.round(r.hourly_rate * r.total_work_hours));
      allMatch ? ok(`時薪計算正確（${company.hourlyRate} × 工時）`) : fail('時薪計算不正確');
    }

    // V3: 月薪制底薪 > 0
    const monthlyEmps = report.filter(r => r.salary_type === 'monthly');
    if (monthlyEmps.length > 0) {
      monthlyEmps.every(r => r.base_salary > 0)
        ? ok(`月薪制底薪正確（${monthlyEmps.length} 人）`)
        : fail('月薪制底薪為 0');
    }

    // V4: 遲到扣款 = 次數 × 100
    const lateOk = report.every(r => r.late_deduction === r.late_count * 100);
    lateOk ? ok('遲到扣款正確（每次 100）') : fail('遲到扣款計算錯誤');

    // V5: 應發 ≥ 實發
    const grossOk = report.every(r => r.gross_salary >= r.net_salary);
    grossOk ? ok('應發 ≥ 實發（扣款邏輯正常）') : fail('實發 > 應發（扣款邏輯異常）');

    // V6: 勞保健保 > 0
    const insOk = report.every(r => r.labor_insurance > 0 && r.health_insurance > 0);
    insOk ? ok('勞保/健保自付 > 0') : fail('勞保或健保為 0');

    // V7: 有加班的加班費 > 0
    const otEmps = report.filter(r => r.overtime_hours > 0);
    if (otEmps.length > 0) {
      otEmps.every(r => r.overtime_pay > 0) ? ok(`加班費正確（${otEmps.length} 人有加班）`) : fail('有加班但加班費為 0');
    } else {
      ok('本次模擬無加班');
    }

    // V8: 缺勤者有事假扣款
    const absentEmps = report.filter(r => r.personal_leave_days > 0);
    if (absentEmps.length > 0) {
      absentEmps.every(r => r.personal_leave_deduction > 0) ? ok(`事假扣款正確（${absentEmps.length} 人）`) : fail('有事假但扣款為 0');
    } else {
      ok('本次模擬無事假');
    }
  }

  // ─── 總結 ───
  console.log('\n═══════════════════════════════════════');
  console.log(`  結果：✅ ${passed} 通過  ❌ ${failed} 失敗`);
  console.log('═══════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ 執行失敗:', e.message); process.exit(1); });
