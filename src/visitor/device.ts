export function parseDevice(userAgent = '') {
    if (!userAgent) {
        return 'Неизвестное устройство';
    }

    let browser = 'Браузер';
    if (userAgent.includes('Edg/') || userAgent.includes('EdgiOS'))
        browser = 'Edge';
    else if (userAgent.includes('CriOS/') || userAgent.includes('Chrome/'))
        browser = 'Chrome';
    else if (userAgent.includes('FxiOS/') || userAgent.includes('Firefox/'))
        browser = 'Firefox';
    else if (userAgent.includes('Safari/')) browser = 'Safari';

    let os = '';
    if (userAgent.includes('Android')) os = 'Android';
    else if (userAgent.includes('iPhone') || userAgent.includes('iPad'))
        os = 'iOS';
    else if (userAgent.includes('Mac OS')) os = 'macOS';
    else if (userAgent.includes('Windows')) os = 'Windows';
    else if (userAgent.includes('Linux')) os = 'Linux';

    return os ? `${browser} · ${os}` : browser;
}

export function parseDeviceKind(userAgent = '') {
    const ua = String(userAgent || '');
    if (/iPad|Tablet|(Android(?!.*Mobile))/i.test(ua)) {
        return 'Планшет';
    }
    if (/Mobi|iPhone|iPod|Android|webOS|BlackBerry|Opera Mini/i.test(ua)) {
        return 'Телефон';
    }
    return 'Компьютер';
}
