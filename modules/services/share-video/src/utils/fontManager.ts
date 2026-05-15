import * as fs from 'fs';
import { GlobalFonts } from '@napi-rs/canvas';

let fontRegistered = false;

/**
 * Registers system fonts for canvas rendering (one-time operation)
 */
export function registerFonts(): void {
  if (fontRegistered) {
    return;
  }

  try {
    // Common system font paths for different OS
    const possibleFonts = [
      // macOS
      '/System/Library/Fonts/Helvetica.ttc',
      '/System/Library/Fonts/SFNSText.ttf',
      '/System/Library/Fonts/HelveticaNeue.ttc',
      // Linux
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      // Windows
      'C:\\Windows\\Fonts\\arial.ttf',
      'C:\\Windows\\Fonts\\arialbd.ttf',
    ];

    for (const fontPath of possibleFonts) {
      if (fs.existsSync(fontPath)) {
        GlobalFonts.registerFromPath(fontPath, 'CustomFont');
        console.log(`✓ Registered font: ${fontPath}`);
        fontRegistered = true;
        break;
      }
    }

    if (!fontRegistered) {
      console.warn('Warning: Could not register custom font, using default');
    }
  } catch (error) {
    console.warn('Warning: Could not register custom font, using default');
  }
}
