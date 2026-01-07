import { unzip } from 'unzipper';
import JSZip from 'jszip';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API Routes
    if (pathname === '/api/upload' && request.method === 'POST') {
      return handleZipUpload(request, env, ctx);
    }

    if (pathname === '/api/create-site' && request.method === 'POST') {
      return createSiteFromZip(request, env);
    }

    if (pathname === '/api/sites' && request.method === 'GET') {
      return listSites(env);
    }

    // Serve hosted websites
    if (pathname.startsWith('/s/')) {
      return serveHostedSite(request, env, pathname);
    }

    // Frontend UI
    return serveFrontendUI();
  }
};

// Handle ZIP upload and extraction
async function handleZipUpload(request, env, ctx) {
  try {
    const contentType = request.headers.get('content-type');
    
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse({ error: 'Invalid content type' }, 400);
    }

    const formData = await request.formData();
    const file = formData.get('zipfile');
    const siteName = formData.get('siteName') || generateSiteId();
    
    if (!file || file.type !== 'application/zip') {
      return jsonResponse({ error: 'Only ZIP files allowed' }, 400);
    }

    // Check file size (10MB limit)
    const maxSize = parseInt(env.MAX_FILE_SIZE) || 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return jsonResponse({ error: `File too large. Max ${formatBytes(maxSize)}` }, 400);
    }

    // Generate unique site ID
    const siteId = generateSiteId();
    
    // Extract and process ZIP
    const extractedFiles = await extractZip(file, env, siteId);
    
    // Find entry point (index.html)
    const entryPoint = findEntryPoint(extractedFiles);
    
    // Create site configuration
    const siteConfig = {
      id: siteId,
      name: siteName,
      files: extractedFiles,
      entryPoint: entryPoint,
      createdAt: new Date().toISOString(),
      url: `${new URL(request.url).origin}/s/${siteId}`,
      directUrl: `${new URL(request.url).origin}/s/${siteId}/${entryPoint}`
    };

    // Store site config in R2
    await env.WEBSITES_BUCKET.put(`sites/${siteId}/config.json`, 
      JSON.stringify(siteConfig));

    return jsonResponse({
      success: true,
      message: 'Website created successfully!',
      site: siteConfig,
      files: extractedFiles.map(f => ({
        name: f.name,
        type: f.type,
        size: f.size,
        url: `${new URL(request.url).origin}/s/${siteId}/${f.name}`
      }))
    });

  } catch (error) {
    console.error('Upload error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Extract ZIP using JSZip
async function extractZip(file, env, siteId) {
  const files = [];
  const zipData = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(zipData);
  
  // Process each file in ZIP
  for (const [filename, zipEntry] of Object.entries(zip.files)) {
    if (!zipEntry.dir) { // Ignore directories
      const fileContent = await zipEntry.async('uint8array');
      const fileType = getMimeType(filename);
      
      // Store in R2
      const r2Key = `sites/${siteId}/${filename}`;
      await env.WEBSITES_BUCKET.put(r2Key, fileContent, {
        httpMetadata: {
          contentType: fileType
        }
      });

      files.push({
        name: filename,
        type: fileType,
        size: fileContent.length,
        path: r2Key
      });
    }
  }
  
  return files;
}

// Find entry point (index.html, default.html, etc.)
function findEntryPoint(files) {
  const entryPoints = [
    'index.html',
    'index.htm',
    'default.html',
    'default.htm',
    'main.html'
  ];
  
  for (const entry of entryPoints) {
    if (files.some(f => f.name.toLowerCase() === entry)) {
      return entry;
    }
  }
  
  // If no index file, return first HTML file
  const htmlFiles = files.filter(f => 
    f.type.includes('html') || f.name.endsWith('.html')
  );
  
  return htmlFiles.length > 0 ? htmlFiles[0].name : files[0].name;
}

// Serve hosted website
async function serveHostedSite(request, env, pathname) {
  try {
    // Extract site ID and file path
    const pathParts = pathname.split('/').filter(p => p);
    const siteId = pathParts[1];
    const requestedFile = pathParts.slice(2).join('/') || 'index.html';
    
    // Try to get the file
    const fileKey = `sites/${siteId}/${requestedFile}`;
    const object = await env.WEBSITES_BUCKET.get(fileKey);
    
    if (object) {
      const headers = new Headers();
      const contentType = getMimeType(requestedFile);
      
      headers.set('Content-Type', contentType);
      headers.set('Cache-Control', 'public, max-age=3600');
      
      // Special handling for HTML files
      if (contentType.includes('html')) {
        let content = await object.text();
        
        // Fix relative paths in HTML
        content = fixRelativePaths(content, `/s/${siteId}/`);
        
        return new Response(content, { headers });
      }
      
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }
    
    // If file not found, check for index.html
    if (requestedFile !== 'index.html') {
      const indexKey = `sites/${siteId}/index.html`;
      const indexObject = await env.WEBSITES_BUCKET.get(indexKey);
      
      if (indexObject) {
        let content = await indexObject.text();
        content = fixRelativePaths(content, `/s/${siteId}/`);
        
        return new Response(content, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }
    
    return new Response('File not found', { status: 404 });
    
  } catch (error) {
    return new Response('Error serving site', { status: 500 });
  }
}

// Fix relative paths in HTML
function fixRelativePaths(html, basePath) {
  // Fix CSS links
  html = html.replace(
    /(<link[^>]*href=["'])(?!https?:\/\/)([^"']*)(["'])/g,
    `$1${basePath}$2$3`
  );
  
  // Fix JS scripts
  html = html.replace(
    /(<script[^>]*src=["'])(?!https?:\/\/)([^"']*)(["'])/g,
    `$1${basePath}$2$3`
  );
  
  // Fix images
  html = html.replace(
    /(<img[^>]*src=["'])(?!https?:\/\/)([^"']*)(["'])/g,
    `$1${basePath}$2$3`
  );
  
  // Fix anchor links
  html = html.replace(
    /(<a[^>]*href=["'])(?!https?:\/\/|#)([^"']*)(["'])/g,
    `$1${basePath}$2$3`
  );
  
  return html;
}

// List all sites
async function listSites(env) {
  const sites = [];
  const list = await env.WEBSITES_BUCKET.list({ prefix: 'sites/' });
  
  for (const obj of list.objects) {
    if (obj.key.endsWith('config.json')) {
      const config = await env.WEBSITES_BUCKET.get(obj.key);
      if (config) {
        sites.push(JSON.parse(await config.text()));
      }
    }
  }
  
  return jsonResponse({ sites });
}

// Helper functions
function generateSiteId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'txt': 'text/plain',
    'pdf': 'application/pdf',
    'zip': 'application/zip'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
