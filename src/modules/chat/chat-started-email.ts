function escapeHtml(value: unknown) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function chatStartedEmailTemplate({
    recipientNickName,
    initiatorNickName,
    messagesUrl,
}: {
    recipientNickName?: string | null;
    initiatorNickName?: string | null;
    messagesUrl: string;
}) {
    return `
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>Новый чат в Scribo</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f6f6f6;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table width="100%" style="max-width:520px;background:#ffffff;border-radius:8px;padding:24px;font-family:Arial,Helvetica,sans-serif;">
            <tr>
              <td>
                <h2 style="margin:0 0 12px 0;color:#111;">С вами начали переписку</h2>
                <p style="color:#333;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
                  ${escapeHtml(recipientNickName || 'Здравствуйте')}, пользователь
                  <strong>${escapeHtml(initiatorNickName || 'Scribo')}</strong>
                  инициировал с вами чат в Scribo.
                </p>
                <p style="color:#555;font-size:14px;line-height:1.5;margin:0;">
                  Откройте сообщения, чтобы прочитать переписку и ответить.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-top:20px;">
                <a href="${escapeHtml(messagesUrl)}" style="display:inline-block;padding:10px 16px;background:#191919;color:#ffffff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;">
                  Открыть чат
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding-top:24px;border-top:1px solid #eaeaea;color:#777;font-size:12px;">
                <p style="margin:0;">Scribo Blog<br/>Это письмо отправлено автоматически при создании нового чата.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}
