// queue.js - Job queue management with priority system

const jobs = new Map(); // userId -> job
const MAX_CONCURRENT_BUILDS = 3; // Maksimal build berjalan bersamaan

function getUserJob(userId) {
  return jobs.get(Number(userId)) || null;
}

function setUserJob(userId, data) {
  jobs.set(Number(userId), { ...data, userId: Number(userId), updatedAt: Date.now() });
}

function removeUserJob(userId) {
  jobs.delete(Number(userId));
}

function isUserBuilding(userId) {
  return jobs.has(Number(userId));
}

function getActiveJobs() {
  return Array.from(jobs.values()).filter(job => 
    job.status === "building" || job.status === "uploading"
  );
}

function getWaitingJobs() {
  const waitingStatuses = ["waiting_zip", "waiting_url", "waiting_appname", "waiting_icon"];
  return Array.from(jobs.values()).filter((j) => waitingStatuses.includes(j.status));
}

function getQueueStats() {
  const all = Array.from(jobs.values());
  
  // Mengelompokkan semua status waiting baik dari alur Build biasa maupun Web to APK
  const waitingStatuses = ["waiting_zip", "waiting_url", "waiting_appname", "waiting_icon"];

  return {
    waiting: all.filter((j) => waitingStatuses.includes(j.status)).length,
    uploading: all.filter((j) => j.status === "uploading").length,
    building: all.filter((j) => j.status === "building").length,
    total: all.length,
  };
}

// Mendapatkan jumlah build aktif yang sedang berjalan
function getActiveBuildCount() {
  return getActiveJobs().length;
}

// Cek apakah masih ada slot untuk build baru
function hasAvailableSlot() {
  return getActiveBuildCount() < MAX_CONCURRENT_BUILDS;
}

// Mendapatkan sisa slot yang tersedia
function getAvailableSlots() {
  return Math.max(0, MAX_CONCURRENT_BUILDS - getActiveBuildCount());
}

// Export MAX_CONCURRENT_BUILDS untuk digunakan di file lain
function getMaxConcurrentBuilds() {
  return MAX_CONCURRENT_BUILDS;
}

module.exports = {
  getUserJob,
  setUserJob,
  removeUserJob,
  isUserBuilding,
  getActiveJobs,
  getWaitingJobs,
  getQueueStats,
  getActiveBuildCount,
  hasAvailableSlot,
  getAvailableSlots,
  getMaxConcurrentBuilds,
  MAX_CONCURRENT_BUILDS, // Export konstanta untuk akses langsung
};