import { serve } from 'bun';
import fs from 'fs';
import path from 'path';

// Store temporary PFX files in memory
const pfxStorage = new Map<string, Buffer>();

// Create server to host PFX files
const server = serve({
  port: 8080,
  fetch(req) {
    const url = new URL(req.url);

    // Serve PFX files
    if (url.pathname.startsWith('/pfx/')) {
      const fileId = url.pathname.replace('/pfx/', '');
      const pfxBuffer = pfxStorage.get(fileId);

      if (pfxBuffer) {
        return new Response(pfxBuffer, {
          headers: {
            'Content-Type': 'application/x-pkcs12',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      return new Response('PFX not found', { status: 404 });
    }

    // Health check
    if (url.pathname === '/') {
      return new Response(`PFX Server Running\nActive files: ${pfxStorage.size}`, {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
});

console.log(`🚀 PFX Server running at http://localhost:${server.port}`);

// Export functions to manage PFX storage
export function storePFX(id: string, buffer: Buffer): string {
  pfxStorage.set(id, buffer);
  return `http://localhost:${server.port}/pfx/${id}`;
}

export function removePFX(id: string) {
  pfxStorage.delete(id);
}

export function clearAllPFX() {
  pfxStorage.clear();
}