import { storage } from './storage';
import type { InsertCompanycamProject, InsertCompanycamUser, InsertCompanycamPhoto, InsertCompanycamChangeHistory } from '@shared/schema';

const BASE_URL = 'https://api.companycam.com/v2';

async function getCompanycamToken(): Promise<string> {
  const tokenRecord = await storage.getOAuthToken('companycam');
  if (tokenRecord?.accessToken) return tokenRecord.accessToken;
  if (process.env.COMPANYCAM_API_TOKEN) return process.env.COMPANYCAM_API_TOKEN;
  throw new Error('No CompanyCam API token configured. Please save your token in Settings.');
}

async function companycamApiFetch(path: string, token: string): Promise<any> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CompanyCam API error ${response.status}: ${text}`);
  }
  return response.json();
}

function unixToDate(ts: number | null | undefined): Date | null {
  if (!ts) return null;
  return new Date(ts * 1000);
}

function detectChanges(
  existing: Record<string, any> | null,
  newData: Record<string, any>,
  entityType: string,
  entityId: string,
  fieldsToCheck: string[]
): InsertCompanycamChangeHistory[] {
  const changes: InsertCompanycamChangeHistory[] = [];

  if (!existing) {
    changes.push({
      entityType,
      entityCompanycamId: entityId,
      changeType: 'created',
      fullSnapshot: newData as any,
    });
    return changes;
  }

  for (const field of fieldsToCheck) {
    const oldVal = existing[field];
    const newVal = newData[field];
    const oldStr = oldVal != null ? String(oldVal) : null;
    const newStr = newVal != null ? String(newVal) : null;
    if (oldStr !== newStr) {
      changes.push({
        entityType,
        entityCompanycamId: entityId,
        changeType: 'field_update',
        fieldName: field,
        oldValue: oldStr,
        newValue: newStr,
      });
    }
  }

  return changes;
}

function mapProjectData(p: any): InsertCompanycamProject {
  const address = p.address || {};
  const coords = p.coordinates || {};
  let featureImageUrl: string | null = null;
  if (p.feature_image && Array.isArray(p.feature_image) && p.feature_image.length > 0) {
    const fi = p.feature_image[0];
    if (fi.uris) {
      const thumb = fi.uris.find((u: any) => u.type === 'thumbnail');
      featureImageUrl = thumb?.uri || fi.uris[0]?.uri || null;
    }
  }

  return {
    companycamId: String(p.id),
    name: p.name || null,
    status: p.status || null,
    archived: p.archived || false,
    streetAddress: address.street_address_1 || null,
    city: address.city || null,
    state: address.state || null,
    postalCode: address.postal_code || null,
    country: address.country || null,
    photoCount: p.photo_count || 0,
    creatorName: p.creator_name || null,
    projectUrl: p.project_url || null,
    publicUrl: p.public_url || null,
    latitude: coords.lat != null ? String(coords.lat) : null,
    longitude: coords.lon != null ? String(coords.lon) : null,
    integrations: p.integrations || null,
    featureImageUrl,
    notepad: p.notepad || null,
    properties: p as any,
    lastSyncedAt: new Date(),
    companycamCreatedAt: unixToDate(p.created_at),
    companycamUpdatedAt: unixToDate(p.updated_at),
  };
}

function mapUserData(u: any): InsertCompanycamUser {
  return {
    companycamId: String(u.id),
    firstName: u.first_name || null,
    lastName: u.last_name || null,
    email: u.email_address || null,
    phoneNumber: u.phone_number || null,
    status: u.status || null,
    userRole: u.user_role || null,
    userUrl: u.user_url || null,
    profileImage: u.profile_image || null,
    properties: u as any,
    lastSyncedAt: new Date(),
    companycamCreatedAt: unixToDate(u.created_at),
    companycamUpdatedAt: unixToDate(u.updated_at),
  };
}

function mapPhotoData(photo: any, projectName: string | null): InsertCompanycamPhoto {
  const uris = photo.uris || [];
  const thumbnailUri = uris.find((u: any) => u.type === 'thumbnail');
  const webUri = uris.find((u: any) => u.type === 'web');
  const originalUri = uris.find((u: any) => u.type === 'original');
  const coords = photo.coordinates || {};

  return {
    companycamId: String(photo.id),
    projectId: photo.project_id ? String(photo.project_id) : null,
    projectName,
    creatorName: photo.creator_name || null,
    status: photo.status || null,
    latitude: coords.lat != null ? String(coords.lat) : null,
    longitude: coords.lon != null ? String(coords.lon) : null,
    thumbnailUrl: thumbnailUri?.uri || null,
    webUrl: webUri?.uri || null,
    originalUrl: originalUri?.uri || null,
    photoUrl: photo.photo_url || null,
    description: photo.description || null,
    capturedAt: unixToDate(photo.captured_at),
    tags: photo.tags || null,
    properties: photo as any,
    lastSyncedAt: new Date(),
    companycamCreatedAt: unixToDate(photo.created_at),
    companycamUpdatedAt: unixToDate(photo.updated_at),
  };
}

const PROJECT_FIELDS = ['name', 'status', 'archived', 'streetAddress', 'city', 'state', 'postalCode', 'photoCount', 'creatorName', 'notepad'];
const USER_FIELDS = ['firstName', 'lastName', 'email', 'phoneNumber', 'status', 'userRole'];
const PHOTO_FIELDS = ['status', 'description', 'creatorName', 'projectName'];

export async function syncCompanycamProjects(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const token = await getCompanycamToken();
  let page = 1;
  const perPage = 50;
  let synced = 0;
  let created = 0;
  let updated = 0;
  let changes = 0;
  let sampleLogged = false;

  console.log('[CompanyCam Sync] Starting project sync from CompanyCam API...');

  while (true) {
    const projects = await companycamApiFetch(`/projects?per_page=${perPage}&page=${page}`, token);
    if (!projects || !Array.isArray(projects) || projects.length === 0) break;

    console.log(`[CompanyCam Sync] Fetched page ${page}: ${projects.length} projects`);

    for (const p of projects) {
      // Log sample project data to understand the structure
      if (!sampleLogged && page === 1 && synced < 3) {
        console.log(`[CompanyCam Sync] Sample project "${p.name}":`);
        console.log(`  - integrations field: ${JSON.stringify(p.integrations)}`);
        console.log(`  - Has external_ids: ${!!p.external_ids}`);
        if (p.external_ids) console.log(`  - external_ids: ${JSON.stringify(p.external_ids)}`);
        if (synced === 2) sampleLogged = true;
      }
      
      const data = mapProjectData(p);
      const existing = await storage.getCompanycamProjectByCompanycamId(data.companycamId);
      const changeEntries = detectChanges(existing as any, data as any, 'project', data.companycamId, PROJECT_FIELDS);

      await storage.upsertCompanycamProject(data);
      synced++;

      if (changeEntries.length > 0) {
        for (const entry of changeEntries) {
          await storage.createCompanycamChangeHistory(entry);
        }
        if (changeEntries[0].changeType === 'created') created++;
        else updated++;
        changes += changeEntries.length;
      }
    }

    if (projects.length < perPage) break;
    page++;
  }

  return { synced, created, updated, changes };
}

export async function syncCompanycamUsers(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const token = await getCompanycamToken();
  let page = 1;
  const perPage = 100;
  let synced = 0;
  let created = 0;
  let updated = 0;
  let changes = 0;

  while (true) {
    const users = await companycamApiFetch(`/users?per_page=${perPage}&page=${page}`, token);
    if (!users || !Array.isArray(users) || users.length === 0) break;

    for (const u of users) {
      const data = mapUserData(u);
      const existing = await storage.getCompanycamUserByCompanycamId(data.companycamId);
      const changeEntries = detectChanges(existing as any, data as any, 'user', data.companycamId, USER_FIELDS);

      await storage.upsertCompanycamUser(data);
      synced++;

      if (changeEntries.length > 0) {
        for (const entry of changeEntries) {
          await storage.createCompanycamChangeHistory(entry);
        }
        if (changeEntries[0].changeType === 'created') created++;
        else updated++;
        changes += changeEntries.length;
      }
    }

    if (users.length < perPage) break;
    page++;
  }

  return { synced, created, updated, changes };
}

export async function syncCompanycamPhotos(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const token = await getCompanycamToken();
  let synced = 0;
  let created = 0;
  let updated = 0;
  let changes = 0;

  const projectsResult = await storage.getCompanycamProjects({ limit: 10000, offset: 0 });
  const allProjects = projectsResult.data;

  for (const project of allProjects) {
    const maxPages = 3;
    const perPage = 50;

    for (let page = 1; page <= maxPages; page++) {
      try {
        const photos = await companycamApiFetch(`/projects/${project.companycamId}/photos?per_page=${perPage}&page=${page}`, token);
        if (!photos || !Array.isArray(photos) || photos.length === 0) break;

        for (const photo of photos) {
          const data = mapPhotoData(photo, project.name);
          const existing = await storage.getCompanycamPhotoByCompanycamId(data.companycamId);
          const changeEntries = detectChanges(existing as any, data as any, 'photo', data.companycamId, PHOTO_FIELDS);

          await storage.upsertCompanycamPhoto(data);
          synced++;

          if (changeEntries.length > 0) {
            for (const entry of changeEntries) {
              await storage.createCompanycamChangeHistory(entry);
            }
            if (changeEntries[0].changeType === 'created') created++;
            else updated++;
            changes += changeEntries.length;
          }
        }

        if (photos.length < perPage) break;
      } catch (err: any) {
        console.error(`Error fetching photos for project ${project.companycamId}: ${err.message}`);
        break;
      }
    }
  }

  return { synced, created, updated, changes };
}

export async function runFullCompanycamSync(): Promise<any> {
  const startTime = Date.now();
  console.log('Starting full CompanyCam sync...');

  const projectStats = await syncCompanycamProjects();
  console.log(`CompanyCam projects synced: ${projectStats.synced}`);

  const userStats = await syncCompanycamUsers();
  console.log(`CompanyCam users synced: ${userStats.synced}`);

  const photoStats = await syncCompanycamPhotos();
  console.log(`CompanyCam photos synced: ${photoStats.synced}`);

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  await storage.purgeCompanycamChangeHistory(twoWeeksAgo);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`CompanyCam sync completed in ${duration}s`);

  try {
    await storage.createAuditLog({
      action: 'companycam_full_sync',
      entityType: 'companycam',
      status: 'success',
      details: { projects: projectStats, users: userStats, photos: photoStats, duration: `${duration}s` } as any,
    });
  } catch (e) {
    console.error('Failed to create audit log:', e);
  }

  return {
    success: true,
    projects: projectStats,
    users: userStats,
    photos: photoStats,
    duration: `${duration}s`,
  };
}
