function isItemAvailable(menuItem, now = new Date()) {
  if (!menuItem.availability) return true;

  const { startTime, endTime } = menuItem.availability;
  const hour = now.getHours();
  const minute = now.getMinutes();
  const current = hour * 60 + minute;

  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);

  return current >= startH * 60 + startM && current < endH * 60 + endM;
}

module.exports = { isItemAvailable };
