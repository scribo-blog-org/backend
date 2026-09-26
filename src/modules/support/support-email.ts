function escapeHtml(value: unknown) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function toHtmlParagraphs(text: unknown) {
    return escapeHtml(text).replace(/\n/g, '<br/>');
}

export function supportEmailTemplate({
    title,
    intro,
    message,
    url,
    buttonLabel = 'Открыть обращение',
}: {
    title: string;
    intro: string;
    message?: string;
    url?: string | null;
    buttonLabel?: string;
}) {
    const button = url
        ? `<tr>
              <td align="center" style="padding-top:20px;">
                <a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#191919;color:#ffffff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;">
                  ${escapeHtml(buttonLabel)}
                </a>
              </td>
            </tr>`
        : '';

    return `
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f6f6f6;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table width="100%" style="max-width:520px;background:#ffffff;border-radius:8px;padding:24px;font-family:Arial,Helvetica,sans-serif;">
            <tr>
              <td>
                <h2 style="margin:0 0 12px 0;color:#111;">${escapeHtml(title)}</h2>
                <p style="color:#333;font-size:15px;line-height:1.5;">${toHtmlParagraphs(intro)}</p>
                ${message ? `<div style="margin-top:16px;padding:12px 16px;background:#f0f2f5;border-radius:6px;color:#333;font-size:14px;line-height:1.5;">${toHtmlParagraphs(message)}</div>` : ''}
              </td>
            </tr>
            ${button}
            <tr>
              <td style="padding-top:24px;border-top:1px solid #eaeaea;color:#777;font-size:12px;">
                <p style="margin:0;">Scribo Blog</p>
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
