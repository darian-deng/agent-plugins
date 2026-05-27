export function truncateError(e, max = 120) {
    const s = String(e).replace(/\n/g, ' ');
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
//# sourceMappingURL=format.js.map