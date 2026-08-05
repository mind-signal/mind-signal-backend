import { Router } from 'express';
import { userApi } from '@05-features/users';
import { authApi } from '@05-features/auth';
import { sessionApi } from '@05-features/sessions';
import { measurementApi } from '@02-processes/measurements';
import engineRouter from '@02-processes/engine/api/engine.routes';
import { chatApi } from '@05-features/neuro-chats';
import analysisRouter from '@05-features/analysis-results/api/analysis.routes';

const router = Router();

router.use('/user', userApi);
router.use('/auth', authApi);
router.use('/sessions', sessionApi);
router.use('/measurements', measurementApi);
router.use('/engine', engineRouter);
router.use('/chat', chatApi);
router.use('/analysis', analysisRouter);

export default router;
