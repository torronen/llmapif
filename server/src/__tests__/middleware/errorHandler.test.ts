import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../../middleware/errorHandler.js';
import type { Request, Response, NextFunction } from 'express';

describe('Error Handler Middleware', () => {
  it('should delegate to next if headers are already sent', () => {
    const err = new Error('Test error');
    const req = {} as Request;
    const res = { headersSent: true } as Response;
    const next = vi.fn() as NextFunction;
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    consoleSpy.mockRestore();
  });

  it('should handle 4xx client errors and return message', () => {
    const err: any = new Error('Client error message');
    err.status = 400;
    err.name = 'ValidationError';
    
    const req = {} as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'Client error message',
        type: 'ValidationError'
      }
    });
    consoleSpy.mockRestore();
  });

  it('should hide 5xx server error messages', () => {
    const err: any = new Error('Secret DB connection error');
    err.status = 500;
    
    const req = {} as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'Internal server error',
        type: 'Error'
      }
    });
    consoleSpy.mockRestore();
  });

  it('should default to 500 if no status is set', () => {
    const err: any = new Error('No status error');
    
    const req = {} as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'Internal server error',
        type: 'Error'
      }
    });
    consoleSpy.mockRestore();
  });
});
