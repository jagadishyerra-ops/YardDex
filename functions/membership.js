// Which families a person belongs to, kept on users/{uid}:
//   familyIds: every family they're in
//   familyId:  the one they're looking at right now (the app shows and saves finds to this one)
// Older user docs only have familyId; they are read as a one-family list.

const MAX_FAMILIES_PER_PERSON = 10;

function idsOf(user) {
  if (Array.isArray(user?.familyIds)) return user.familyIds.filter(x => typeof x === "string" && x);
  return user?.familyId ? [user.familyId] : [];
}

// Adds a family and makes it the current one.
function withFamily(user, fid) {
  const ids = idsOf(user);
  return { familyIds: ids.includes(fid) ? ids : [...ids, fid], familyId: fid };
}

// Removes a family; if it was the current one, switches to another (or none).
function withoutFamily(user, fid) {
  const ids = idsOf(user).filter(x => x !== fid);
  const cur = user?.familyId && user.familyId !== fid && ids.includes(user.familyId) ? user.familyId : (ids[0] || null);
  return { familyIds: ids, familyId: cur };
}

module.exports = { MAX_FAMILIES_PER_PERSON, idsOf, withFamily, withoutFamily };
