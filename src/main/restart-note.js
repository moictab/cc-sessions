'use strict';
// What restarting a session costs, and the note it gets when it comes back: the conversation
// is intact (--resume), but everything that lived in the old process is gone.
// The note is typed into the conversation, so it goes in the interface language: `t` is the
// translator (see shared/i18n.js).

/** The things a restart kills, as a phrase. */
function lostOnRestart(t) {
  return t('restartNote.lost');
}

/**
 * `session`: { name, cwd } of the session that asked for the restart (with set_plugin), named with
 * its folder so that a note nobody wrote for it doesn't pass for its own.
 */
function restartNote(t, { bySession, change, sessionNote, session }) {
  const why = change ? t('restartNote.why', { change }) : '';
  const lost = lostOnRestart(t);
  if (bySession) {
    let text = t('restartNote.bySession', { why, lost });
    const own = String(sessionNote || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (own) text += t('restartNote.ownNote', { note: own, name: (session && session.name) || '?', folder: (session && session.cwd) || '?' });
    return text;
  }
  return t('restartNote.byUser', { why, lost });
}

module.exports = { lostOnRestart, restartNote };
