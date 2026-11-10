'use strict';
// What restarting a session costs, and the note it gets when it comes back: the conversation
// is intact (--resume), but everything that lived in the old process is gone.
// The note is typed into the conversation, so it goes in the interface language: `t` is the
// translator (see shared/i18n.js).

/** The things a restart kills, as a phrase. */
function lostOnRestart(t) {
  return t('restartNote.lost');
}

function restartNote(t, { bySession, change, sessionNote }) {
  const why = change ? t('restartNote.why', { change }) : '';
  const lost = lostOnRestart(t);
  if (bySession) {
    let text = t('restartNote.bySession', { why, lost });
    const own = String(sessionNote || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (own) text += t('restartNote.ownNote', { note: own });
    return text;
  }
  return t('restartNote.byUser', { why, lost });
}

module.exports = { lostOnRestart, restartNote };
