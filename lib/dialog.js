// dialog.js — 崩溃风险弹窗（需求 R5 的“两个选项”）
//
// 为什么用 PowerShell/WinForms 而不写 web UI：p2m 本体是零依赖 Cordis 宿主插件，
// 不依赖 dsh 前端版本；而 DSH 跑在用户桌面 Windows 上，PowerShell 弹原生双按钮
// 对话框是当前最可靠的桌面交互通道。弹窗失败（无桌面会话/被杀软拦）时按
// 安全默认返回 'cancel'（取消开启），绝不让“无法确认”变成“直接放行”。

import { spawn } from 'node:child_process'

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$msg = [Environment]::GetEnvironmentVariable('P2M_DLG_MSG')
$title = [Environment]::GetEnvironmentVariable('P2M_DLG_TITLE')
$f = New-Object System.Windows.Forms.Form
$f.Text = $title
$f.StartPosition = 'CenterScreen'
$f.Width = 620
$f.Height = 240
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$l = New-Object System.Windows.Forms.Label
$l.Text = $msg
$l.AutoSize = $false
$l.Width = 560
$l.Height = 100
$l.Left = 20
$l.Top = 18
$l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$bCancel = New-Object System.Windows.Forms.Button
$bCancel.Text = '取消开启'
$bCancel.DialogResult = 'Cancel'
$bCancel.Width = 150
$bCancel.Height = 36
$bCancel.Left = 280
$bCancel.Top = 140
$bForce = New-Object System.Windows.Forms.Button
$bForce.Text = '无视风险继续使用'
$bForce.DialogResult = 'OK'
$bForce.Width = 180
$bForce.Height = 36
$bForce.Left = 92
$bForce.Top = 140
$f.CancelButton = $bCancel
$f.AcceptButton = $bForce
$f.Controls.Add($l)
$f.Controls.Add($bCancel)
$f.Controls.Add($bForce)
$f.Add_Shown({ $f.Activate() })
$r = $f.ShowDialog()
if ($r -eq 'OK') { Write-Output 'FORCE' } else { Write-Output 'CANCEL' }
`

/**
 * 弹“崩溃风险”双按钮框。
 * @param {string} name 插件名/entry id
 * @param {string} detail 试跑失败详情（截断）
 * @param {object} [opts]
 * @param {string} [opts.ui] 'auto'|'desktop'|'none'（none=不弹，直接返回 cancel）
 * @returns {Promise<'cancel'|'force'>}
 */
export function askCrashRisk(name, detail, { ui = 'auto' } = {}) {
  if (ui === 'none') return Promise.resolve('cancel')
  const title = 'DSH-P2M：检测到崩溃风险'
  const msg = [
    `插件「${name}」试运行未通过，继续开启可能导致 DSH 崩溃：`,
    '',
    (detail || '(无详情)').slice(0, 600),
    '',
    '选择「取消开启」将隔离该插件（可在 p2m 中恢复）；',
    '选择「无视风险继续使用」将尝试直接开启，风险自负。',
  ].join('\n')
  return new Promise((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
        {
          env: {
            ...process.env,
            P2M_DLG_TITLE: title,
            P2M_DLG_MSG: msg,
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      )
      let out = ''
      child.stdout.on('data', (d) => { out += d.toString() })
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        resolve('cancel') // 超时 → 安全默认
      }, 60_000)
      child.on('error', () => {
        clearTimeout(timer)
        resolve('cancel')
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(out.includes('FORCE') ? 'force' : 'cancel')
      })
    } catch {
      resolve('cancel') // 任何异常 → 安全默认
    }
  })
}
