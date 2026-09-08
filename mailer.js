'use strict';
// إرسال بريد الدعوة عبر Resend API (بدون تبعيات — fetch مدمج في Node 22).
// يعمل فقط إذا ضبطت RESEND_API_KEY و MAIL_FROM. وإلا يرجع false بهدوء (fallback: رابط يدوي).
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'ASAP Surveys <onboarding@resend.dev>';
const BRAND = process.env.MAIL_BRAND || 'منصة استبيانات أساب';

function inviteHtml(link) {
  return `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f5fa;font-family:Segoe UI,Tahoma,Arial,sans-serif">
  <div style="max-width:520px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6e8f0">
    <div style="background:linear-gradient(160deg,#150f36,#1f1550);padding:28px 24px;text-align:center;color:#fff">
      <div style="font-size:20px;font-weight:800">${BRAND}</div>
    </div>
    <div style="padding:28px 24px;color:#1f2333;line-height:1.8">
      <p style="margin:0 0 12px;font-size:16px">مرحبًا،</p>
      <p style="margin:0 0 20px">تمت دعوتك لإنشاء حساب على ${BRAND}. اضغط الزر أدناه لتعيين كلمة مرورك وتفعيل حسابك:</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#7B2E8E;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;display:inline-block">تفعيل الحساب</a>
      </p>
      <p style="margin:16px 0 0;font-size:13px;color:#6b7280">أو انسخ الرابط:<br><span style="word-break:break-all;color:#29ABE2">${link}</span></p>
    </div>
  </div></body></html>`;
}

// returns true if the email was accepted by Resend, false otherwise
async function maybeSendInvite(to, link) {
  if (!RESEND_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        subject: `دعوة للانضمام إلى ${BRAND}`,
        html: inviteHtml(link)
      })
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { maybeSendInvite };
